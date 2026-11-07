/**
 * SovereignReactor on a disposable anvil (D-swap-09): a Dutch order fills at the decayed price of the second it is
 * mined (linear, monotone, bounded: `intent.decay.monotone-and-bounded`); a replayed signature reverts NonceUsed; a fill
 * after the deadline reverts Expired; a bad decay reverts BadDecay; a cancelled order cannot fill; the swapper signs a
 * permit with the order and pays no gas; the reactor holds nothing.
 *
 * Skips without a chain; CI with REQUIRE_EVM_CHAIN=1 must run it. Sends from this file's own derived account.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseSignature, parseUnits, type Abi, type Address, type Hex } from 'viem';
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
const abi = (name: Parameters<typeof loadArtifact>[0]) => loadArtifact(name).abi as Abi;

const ORDER_TYPES = {
  IntentOrder: [
    { name: 'swapper', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'tokenOut', type: 'address' },
    { name: 'startOut', type: 'uint256' },
    { name: 'endOut', type: 'uint256' },
    { name: 'decayStart', type: 'uint256' },
    { name: 'decayEnd', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;
const NO_PERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex };

describeOnChain('SovereignReactor onchain', () => {
  if (!devChainMod) return;
  let c: DevChainClients;
  let reactor: Address;
  let tokenIn: Address;
  let tokenOut: Address;
  const swapper = privateKeyToAccount(generatePrivateKey());

  const send = async (hash: Hex) => {
    const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction failed: ${hash}`);
    return receipt;
  };
  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[] = []) => {
    const a = loadArtifact(name);
    const hash = await c.walletClient.deployContract({
      abi: a.abi as Abi,
      bytecode: a.bytecode as Hex,
      args,
      account: c.walletClient.account!,
      chain: c.walletClient.chain,
    });
    return (await send(hash)).contractAddress as Address;
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
  const revertOf = (functionName: string, args: unknown[], account: Address = c.deployer) =>
    c.publicClient.simulateContract({ address: reactor, abi: abi('SovereignReactor'), functionName, args, account }).then(
      () => 'no revert',
      (err: Error & { cause?: { data?: { errorName?: string } } }) => err.cause?.data?.errorName ?? err.message,
    );
  const now = async () => (await c.publicClient.getBlock()).timestamp;
  const balance = (token: Address, who: Address) => read<bigint>(token, 'TestToken', 'balanceOf', [who]);
  let nextNonce = 1n;
  const order = async (over: Partial<Record<string, bigint | Address>> = {}) => {
    const t = await now();
    return {
      swapper: swapper.address,
      tokenIn,
      amountIn: parseUnits('10', 6),
      tokenOut,
      startOut: parseUnits('100', 18),
      endOut: parseUnits('90', 18),
      decayStart: t - 30n,
      decayEnd: t + 30n,
      deadline: t + 300n,
      nonce: nextNonce++,
      ...over,
    };
  };
  const sign = async (o: Awaited<ReturnType<typeof order>>) =>
    swapper.signTypedData({
      domain: { name: 'SovereignReactor', version: '1', chainId: c.walletClient.chain!.id, verifyingContract: reactor },
      types: ORDER_TYPES,
      primaryType: 'IntentOrder',
      message: o,
    });

  beforeAll(async () => {
    c = await devChainMod.devSuiteClients(import.meta.url);
    reactor = await deploy('SovereignReactor');
    tokenIn = await deploy('TestToken', ['RX In', 'RXI', 6]);
    tokenOut = await deploy('TestToken', ['RX Out', 'RXO', 18]);
    await write(tokenIn, 'TestToken', 'mint', [swapper.address, parseUnits('1000', 6)]);
    await write(tokenOut, 'TestToken', 'mint', [c.deployer, parseUnits('100000', 18)]);
    await write(tokenOut, 'TestToken', 'approve', [reactor, parseUnits('100000', 18)]);
    // The swapper approves the reactor once (its own transaction); later orders may carry a permit instead.
    await devChainMod.fundDevAccount(c.publicClient, swapper.address);
    const swapperWallet = createWalletClient({ account: swapper, chain: c.walletClient.chain, transport: http(c.rpcUrl) });
    await send(
      await swapperWallet.writeContract({
        address: tokenIn,
        abi: abi('TestToken'),
        functionName: 'approve',
        args: [reactor, parseUnits('20', 6)],
        chain: c.walletClient.chain,
        account: swapper,
      }),
    );
  }, 120_000);

  it('fills at the decayed price of the second it is mined, and the decay is monotone and bounded', async () => {
    const o = await order();
    const signature = await sign(o);
    const before = await balance(tokenOut, swapper.address);
    const receipt = await write(reactor, 'SovereignReactor', 'fill', [o, signature, NO_PERMIT]);
    const t = (await c.publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
    const expected = await read<bigint>(reactor, 'SovereignReactor', 'outAt', [o, t]);
    expect((await balance(tokenOut, swapper.address)) - before).toBe(expected);
    expect(expected).toBe(o.startOut - ((o.startOut - o.endOut) * (t - o.decayStart)) / (o.decayEnd - o.decayStart));
    expect(await read<boolean>(reactor, 'SovereignReactor', 'nonceSpent', [swapper.address, o.nonce])).toBe(true);
    // Monotone and bounded over the whole window and past it.
    let last = o.startOut;
    for (let s = o.decayStart - 10n; s <= o.decayEnd + 10n; s += 5n) {
      const at = await read<bigint>(reactor, 'SovereignReactor', 'outAt', [o, s]);
      expect(at <= last && at >= o.endOut && at <= o.startOut).toBe(true);
      last = at;
    }
    for (const token of [tokenIn, tokenOut]) expect(await balance(token, reactor)).toBe(0n);
  });

  it('a replayed signature is refused: the nonce is spent and the second fill reverts', async () => {
    const o = await order();
    const signature = await sign(o);
    await write(reactor, 'SovereignReactor', 'fill', [o, signature, NO_PERMIT]);
    expect(await revertOf('fill', [o, signature, NO_PERMIT])).toBe('NonceUsed');
  });

  it('a fill after the deadline, a bad decay, a wrong signer and a cancelled order are refused', async () => {
    const t = await now();
    const late = await order({ decayStart: t - 100n, decayEnd: t - 50n, deadline: t - 1n });
    expect(await revertOf('fill', [late, await sign(late), NO_PERMIT])).toBe('Expired');
    const bad = await order({ startOut: 1n, endOut: 2n });
    expect(await revertOf('fill', [bad, await sign(bad), NO_PERMIT])).toBe('BadDecay');
    const other = await order({ swapper: privateKeyToAccount(generatePrivateKey()).address });
    expect(await revertOf('fill', [other, await sign(other), NO_PERMIT])).toBe('BadSignature');
    const cancelled = await order();
    const swapperWallet = createWalletClient({ account: swapper, chain: c.walletClient.chain, transport: http(c.rpcUrl) });
    await send(
      await swapperWallet.writeContract({
        address: reactor,
        abi: abi('SovereignReactor'),
        functionName: 'cancel',
        args: [cancelled.nonce],
        chain: c.walletClient.chain,
        account: swapper,
      }),
    );
    expect(await revertOf('fill', [cancelled, await sign(cancelled), NO_PERMIT])).toBe('NonceUsed');
  });

  it('a gasless order carries the token permit: the swapper signs both and sends nothing', async () => {
    // Spend the earlier approval so the permit is what lets the reactor move the input.
    const swapperWallet = createWalletClient({ account: swapper, chain: c.walletClient.chain, transport: http(c.rpcUrl) });
    await send(
      await swapperWallet.writeContract({
        address: tokenIn,
        abi: abi('TestToken'),
        functionName: 'approve',
        args: [reactor, 0n],
        chain: c.walletClient.chain,
        account: swapper,
      }),
    );
    const o = await order();
    const pNonce = await read<bigint>(tokenIn, 'TestToken', 'nonces', [swapper.address]);
    const permitSig = await swapper.signTypedData({
      domain: { name: 'RX In', version: '1', chainId: c.walletClient.chain!.id, verifyingContract: tokenIn },
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
      message: { owner: swapper.address, spender: reactor, value: o.amountIn, nonce: pNonce, deadline: o.deadline },
    });
    const { v, r, s, yParity } = parseSignature(permitSig);
    const before = await balance(tokenIn, swapper.address);
    await write(reactor, 'SovereignReactor', 'fill', [
      o,
      await sign(o),
      { value: o.amountIn, deadline: o.deadline, v: Number(v ?? BigInt(yParity + 27)), r, s },
    ]);
    expect(before - (await balance(tokenIn, swapper.address))).toBe(o.amountIn);
  });
});
