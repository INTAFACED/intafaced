/**
 * Paying a swap's network fee in a token (RC-dex-protocol-02), on a disposable anvil: the FeeTokenRelay contract with
 * the fail-closed oracle, a TEST stable token and a pool, driven through this service's own fee-relay module.
 *
 * A wallet that holds only the stable token and no native currency signs a permit and the order; a relayer (an
 * impersonated address with TEST ETH) sends it. The charge is checked against the formula from the oracle's mark and the
 * relay's published markup, the person's native balance stays zero, and a token off the allowlist, a stale oracle and a
 * charge above the signed one all refuse by name.
 *
 * Skips without a chain; CI with REQUIRE_EVM_CHAIN=1 must run it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { encodeAbiParameters, keccak256, parseUnits, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import { loadArtifact } from '../chain/artifacts.js';
import { FEE_RELAY_ABI, planFeeSwap, quoteFee, relayFeeSwap, type FeeRelayChain, type FeeRelaySetting } from './fee-relay.js';

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();
const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

const REPORTERS: [Address, Address] = ['0x00000000000000000000000000000000000a7e1a', '0x00000000000000000000000000000000000a7e1b'];
const RELAYER: Address = '0x0000000000000000000000000000000000fee5e2';
const MARK_USD = 400_000_000_000_000n; // TEST: 1 TEST USD = 0.0004 TEST ETH
const MARKUP_BPS = 500n;
const STALENESS = 86_400;
const GAS_LIMIT = 400_000n;
const FEE_CAP = 100_000_000_000n;

describeOnChain('FeeTokenRelay: a stable-only wallet swaps and pays the fee in that token', () => {
  if (!devChainMod) return;
  let clients: DevChainClients;
  let pc: PublicClient;
  let usd: Address;
  let other: Address;
  let eur: Address;
  let pool: Address;
  let oracle: Address;
  let relay: Address;
  let setting: FeeRelaySetting;
  let chainId: number;
  const person = privateKeyToAccount(generatePrivateKey());

  const send = async (hash: Hex) => {
    const receipt = await pc.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  };
  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[]) => {
    const a = loadArtifact(name);
    const hash = await clients.walletClient.deployContract({
      abi: a.abi,
      bytecode: a.bytecode as Hex,
      args,
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    return (await send(hash)).contractAddress as Address;
  };
  const write = async (address: Address, name: Parameters<typeof loadArtifact>[0], functionName: string, args: unknown[], from?: Address) =>
    send(
      await clients.walletClient.writeContract({
        address,
        abi: loadArtifact(name).abi,
        functionName,
        args,
        account: from ?? clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
  const balance = async (token: Address, who: Address) =>
    (await pc.readContract({ address: token, abi: loadArtifact('TestToken').abi, functionName: 'balanceOf', args: [who] })) as bigint;
  const feeChain = () => pc as unknown as FeeRelayChain;
  /** The relayer stand-in: sends the call from the impersonated relayer, as local-test-chain.mjs's /relay does. */
  const post = async (_url: string, body: unknown) => {
    const call = body as { to: Address; data: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    const hash = (await pc.request({
      method: 'eth_sendTransaction',
      params: [{ from: RELAYER, ...call }],
    } as never)) as Hex;
    return { status: 200, body: { hash, relayer: RELAYER } };
  };
  const refusalOf = (err: unknown) => (err instanceof TRPCError ? err.message.split(':')[0] : String(err));

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    clients = await devChainMod.devSuiteClients(import.meta.url);
    pc = clients.publicClient;
    chainId = await pc.getChainId();
    for (const who of [RELAYER, ...REPORTERS]) {
      await pc.request({ method: 'anvil_impersonateAccount', params: [who] } as never);
      await pc.request({ method: 'anvil_setBalance', params: [who, toHex(parseUnits('100', 18))] } as never);
    }
    usd = await deploy('TestToken', ['TEST USD', 'TESTUSD', 6]);
    other = await deploy('TestToken', ['TEST Other', 'TESTO', 18]);
    eur = await deploy('TestToken', ['TEST EUR', 'TESTEUR', 6]);
    const { factory } = await devChainMod.deployPoolFactory(clients);
    await write(factory, 'PoolFactory', 'createPool', [usd, other, 30]);
    pool = (await pc.readContract({
      address: factory,
      abi: loadArtifact('PoolFactory').abi,
      functionName: 'getPool',
      args: [usd, other, 30],
    })) as Address;
    const token0 = (await pc.readContract({
      address: pool,
      abi: loadArtifact('ConstantProductPool').abi,
      functionName: 'token0',
    })) as Address;
    const depth = { [usd.toLowerCase()]: parseUnits('100000', 6), [other.toLowerCase()]: parseUnits('100000', 18) };
    for (const token of [usd, other]) {
      await write(token, 'TestToken', 'mint', [clients.deployer, depth[token.toLowerCase()]]);
      await write(token, 'TestToken', 'approve', [pool, depth[token.toLowerCase()]]);
    }
    const token1 = token0.toLowerCase() === usd.toLowerCase() ? other : usd;
    await write(pool, 'ConstantProductPool', 'mint', [clients.deployer, depth[token0.toLowerCase()], depth[token1.toLowerCase()]]);

    oracle = await deploy('FailClosedOracle', [...REPORTERS, STALENESS, 100]);
    for (const reporter of REPORTERS) {
      await write(oracle, 'FailClosedOracle', 'report', [usd, MARK_USD], reporter);
      await write(oracle, 'FailClosedOracle', 'report', [eur, 440_000_000_000_000n], reporter);
    }
    // TEST EUR's reports made older than the bound (feedA is slot 0, feedB slot 1; updatedAt is the word after the price).
    const { timestamp } = await pc.getBlock();
    for (const slot of [0n, 1n]) {
      const base = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [eur, slot])));
      await pc.request({
        method: 'anvil_setStorageAt',
        params: [oracle, toHex(base + 1n, { size: 32 }), toHex(timestamp - BigInt(STALENESS) - 60n, { size: 32 })],
      } as never);
    }
    relay = await deploy('FeeTokenRelay', [oracle, clients.deployer, Number(MARKUP_BPS)]);
    await write(relay, 'FeeTokenRelay', 'setFeeToken', [usd, true]);
    await write(relay, 'FeeTokenRelay', 'setFeeToken', [eur, true]);
    setting = { relay, url: 'http://relayer.invalid/relay', gasLimit: GAS_LIMIT };

    // The person: TEST USD only, and no native currency at all.
    await write(usd, 'TestToken', 'mint', [person.address, parseUnits('100', 6)]);
    await pc.request({ method: 'anvil_setBalance', params: [person.address, '0x0'] } as never);
  });

  it('prices the fee at the oracle mark plus the published markup, rounded up', async () => {
    const maxFee = 2_000_000_000n;
    const quote = await quoteFee(feeChain(), setting, usd, maxFee);
    const gasWei = GAS_LIMIT * maxFee;
    const numerator = gasWei * 10n ** 6n * (10_000n + MARKUP_BPS);
    const denominator = MARK_USD * 10_000n;
    expect(quote.gasWei).toBe(gasWei.toString());
    expect(quote.markWad).toBe(MARK_USD.toString());
    expect(quote.markupBps).toBe(Number(MARKUP_BPS));
    expect(BigInt(quote.charge)).toBe((numerator + denominator - 1n) / denominator);
  });

  it('refuses a token off the allowlist and a stale oracle by name', async () => {
    await expect(quoteFee(feeChain(), setting, other, 1_000_000_000n).catch(refusalOf)).resolves.toBe('protocol.fee_token_not_allowlisted');
    await expect(quoteFee(feeChain(), setting, eur, 1_000_000_000n).catch(refusalOf)).resolves.toBe('protocol.fee_token_oracle_stale');
  });

  it('swaps from a wallet with no native currency: the relayer pays the gas, the person pays the charge in TEST USD', async () => {
    const amountIn = parseUnits('10', 6);
    const maxFee = 2_000_000_000n;
    const out = (await pc.readContract({
      address: pool,
      abi: loadArtifact('ConstantProductPool').abi,
      functionName: 'getAmountOut',
      args: [amountIn, usd],
    })) as bigint;
    const plan = await planFeeSwap(
      feeChain(),
      setting,
      chainId,
      { owner: person.address, pool, tokenIn: usd, amountIn, minAmountOut: (out * 99n) / 100n, feeToken: usd },
      maxFee,
      60,
    );
    // One permit: the swap's input and the fee are the same token, so one allowance covers both.
    expect(plan.permits).toHaveLength(1);
    expect(BigInt(plan.permits[0]!.message.value!)).toBe(amountIn + BigInt(plan.quote.charge));
    const sign = (typed: (typeof plan.permits)[number]) => {
      const { EIP712Domain: _d, ...types } = typed.types;
      return person.signTypedData({
        domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Address },
        types,
        primaryType: typed.primaryType,
        message: typed.message,
      } as never);
    };
    const permitSignature = await sign(plan.permits[0]!);
    const orderSignature = await sign(plan.order);
    const order = plan.order.message as never;
    const input = {
      order,
      signature: orderSignature,
      permits: [
        {
          token: plan.permits[0]!.domain.verifyingContract,
          value: plan.permits[0]!.message.value!,
          deadline: plan.permits[0]!.message.deadline!,
          signature: permitSignature,
        },
      ],
      maxFeePerGasWei: maxFee.toString(),
      maxPriorityFeePerGasWei: '1000000000',
    };

    const relayerSent = await pc.getTransactionCount({ address: RELAYER });
    // An order altered after signing is refused; so is one signed for less than the relay now charges.
    const altered = { ...input, order: { ...plan.order.message, maxCharge: '1' } as never };
    await expect(relayFeeSwap(feeChain(), setting, chainId, altered, FEE_CAP, post).catch(refusalOf)).resolves.toBe(
      'protocol.fee_swap_signature_invalid',
    );
    const cheap = { ...plan.order, message: { ...plan.order.message, maxCharge: '1' } };
    const signedCheap = { ...input, order: cheap.message as never, signature: await sign(cheap) };
    await expect(relayFeeSwap(feeChain(), setting, chainId, signedCheap, FEE_CAP, post).catch(refusalOf)).resolves.toBe(
      'protocol.fee_charge_above_signed',
    );
    expect(await pc.getTransactionCount({ address: RELAYER }), 'nothing was sent for a refused order').toBe(relayerSent);

    const usdBefore = await balance(usd, person.address);
    const relayerUsdBefore = await balance(usd, RELAYER);
    const { hash, relayer } = await relayFeeSwap(feeChain(), setting, chainId, input, FEE_CAP, post);
    expect(relayer.toLowerCase()).toBe(RELAYER.toLowerCase());
    const receipt = await send(hash);
    expect(receipt.from.toLowerCase()).toBe(RELAYER.toLowerCase());

    const charged = (await pc.getContractEvents({
      address: relay,
      abi: FEE_RELAY_ABI,
      eventName: 'FeeCharged' as never,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    })) as unknown as Array<{ args: { charge: bigint; markWad: bigint; gasWei: bigint } }>;
    expect(charged).toHaveLength(1);
    expect(charged[0]!.args.charge.toString()).toBe(plan.quote.charge);
    expect(await balance(usd, person.address)).toBe(usdBefore - amountIn - BigInt(plan.quote.charge));
    expect(await balance(usd, RELAYER)).toBe(relayerUsdBefore + BigInt(plan.quote.charge));
    expect(await balance(other, person.address)).toBeGreaterThanOrEqual((out * 99n) / 100n);
    expect(await pc.getBalance({ address: person.address })).toBe(0n);

    // The same signed order cannot be sent twice: its nonce is spent.
    await expect(relayFeeSwap(feeChain(), setting, chainId, input, FEE_CAP, post).catch(refusalOf)).resolves.toBe(
      'protocol.fee_relay_refused',
    );
  });
});

// Keep the ABI this module hand-writes in step with the compiled contract.
describe('fee-relay ABI matches the compiled FeeTokenRelay', () => {
  it('names every function and error the module uses with the compiled signatures', async () => {
    const { toFunctionSignature } = await import('viem');
    const compiled = loadArtifact('FeeTokenRelay').abi.filter((e) => ['function', 'error', 'event'].includes(e.type));
    const sig = (e: (typeof compiled)[number]) => toFunctionSignature(e as never);
    const ours = FEE_RELAY_ABI.filter(
      (e) => ['function', 'error', 'event'].includes(e.type) && !['Stale', 'MissingReport', 'Disagreement'].includes(e.name),
    );
    const theirs = new Set(compiled.map(sig));
    for (const entry of ours) expect(theirs, `${entry.name}`).toContain(sig(entry as never));
  });
});
