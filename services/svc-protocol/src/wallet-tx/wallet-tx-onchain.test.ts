/**
 * Claim links (D-swap-12) and speed up / cancel (RC-dex-protocol-01), on a disposable anvil, through this service's own
 * wallet-tx module and the committed ClaimLinkEscrow artefact.
 *
 * Claim links: a link pays its bound recipient once and a second claim reverts; another key's signature, or a claim
 * naming a recipient the key did not sign, reverts; before expiry nobody can claw back; after it nobody can claim and
 * only the sender can claw back; the escrow's balance always equals its open links. Replacement: a pending transfer's
 * speed-up has its nonce, its call and both fees at least the bump; a cancel is a zero-value self-send at that nonce;
 * once mined it refuses protocol.tx_final; another account's hash refuses protocol.tx_not_yours.
 *
 * Skips without a chain; CI with REQUIRE_EVM_CHAIN=1 must run it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashMessage,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import { loadArtifact } from '../chain/artifacts.js';
import { CLAIM_ESCROW_ABI, claimLinkConfig, getClaimLink, listClaimLinks, WalletTxRefusal } from './claim-link.js';
import { buildReplacement, bumpFee } from './replacement.js';

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();
const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

const MIN_EXPIRY = 60n;
const MAX_EXPIRY = 86_400n;
const SETTING = { bumpBps: 2000, ceilingWei: 1_000_000_000_000n };

describeOnChain('ClaimLinkEscrow and the replacement builder', () => {
  if (!devChainMod) return;
  let clients: DevChainClients;
  let pc: PublicClient;
  let token: Address;
  let escrow: Address;
  const sender = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
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
  const balance = async (who: Address) =>
    (await pc.readContract({ address: token, abi: loadArtifact('TestToken').abi, functionName: 'balanceOf', args: [who] })) as bigint;
  const write = async (account: PrivateKeyAccount, address: Address, abi: unknown, functionName: string, args: unknown[]) =>
    mined(await wallet(account).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }));
  /** The revert name a call gets, from a simulation at the latest block. */
  const revertOf = async (account: PrivateKeyAccount, functionName: 'claim' | 'clawback' | 'create', args: readonly unknown[]) =>
    pc.simulateContract({ account, address: escrow, abi: CLAIM_ESCROW_ERRORS, functionName, args: args as never }).then(
      () => 'no revert',
      (err: Error) => /Error: (\w+)\(\)/.exec(err.message)?.[1] ?? err.message,
    );
  /** Locks `amount` under a new link key; returns the key. */
  const createLink = async (amount: bigint, lifetime = MIN_EXPIRY + 30n) => {
    const key = privateKeyToAccount(generatePrivateKey());
    await write(sender, token, loadArtifact('TestToken').abi, 'approve', [escrow, amount]);
    await write(sender, escrow, CLAIM_ESCROW_ABI, 'create', [token, amount, key.address, lifetime]);
    return key;
  };
  /** What the browser signs with the link key: keccak(abi.encode(escrow, chainId, id, to)) as a personal message. */
  const signClaim = async (key: PrivateKeyAccount, id: Address, to: Address) => {
    const claimHash = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
        [escrow, BigInt(await pc.getChainId()), id, to],
      ),
    );
    const digest = await pc.readContract({ address: escrow, abi: CLAIM_ESCROW_ABI, functionName: 'claimDigest', args: [id, to] });
    expect(digest).toBe(hashMessage({ raw: claimHash }));
    return key.signMessage({ message: { raw: claimHash } });
  };
  const invariant = async () => {
    const open = (await pc.readContract({ address: escrow, abi: CLAIM_ESCROW_ABI, functionName: 'openAmount', args: [token] })) as bigint;
    expect(await balance(escrow), 'claimlink.invariant.balance-equals-open-escrows').toBe(open);
  };

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    clients = await devChainMod.devSuiteClients(import.meta.url);
    pc = clients.publicClient;
    for (const who of [sender, recipient, stranger])
      await pc.request({ method: 'anvil_setBalance', params: [who.address, toHex(parseUnits('10', 18))] } as never);
    token = await deploy('TestToken', ['TEST Token A', 'TESTA', 6]);
    escrow = await deploy('ClaimLinkEscrow', [MIN_EXPIRY, MAX_EXPIRY]);
    await mined(
      await clients.walletClient.writeContract({
        address: token,
        abi: loadArtifact('TestToken').abi,
        functionName: 'mint',
        args: [sender.address, parseUnits('100', 6)],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
  });

  it('publishes its expiry bounds from the contract, and refuses a zero or inverted bound at deploy', async () => {
    const config = await claimLinkConfig(pc, escrow);
    expect(config).toMatchObject({ minExpirySeconds: Number(MIN_EXPIRY), maxExpirySeconds: Number(MAX_EXPIRY) });
    await expect(deploy('ClaimLinkEscrow', [0n, 10n])).rejects.toThrow();
    await expect(deploy('ClaimLinkEscrow', [10n, 5n])).rejects.toThrow();
    const key = privateKeyToAccount(generatePrivateKey());
    expect(await revertOf(sender, 'create', [token, 1n, key.address, MIN_EXPIRY - 1n])).toBe('ExpiryOutOfBounds');
    expect(await revertOf(sender, 'create', [token, 1n, key.address, MAX_EXPIRY + 1n])).toBe('ExpiryOutOfBounds');
  });

  it('pays the bound recipient once; a second claim, another key or another recipient reverts', async () => {
    const amount = parseUnits('2', 6);
    const before = await balance(sender.address);
    const key = await createLink(amount);
    expect(await balance(sender.address)).toBe(before - amount);
    await invariant();
    const sig = await signClaim(key, key.address, recipient.address);
    // Another key's signature, and the link key's signature replayed for a different recipient, both revert.
    const forged = await signClaim(privateKeyToAccount(generatePrivateKey()), key.address, recipient.address);
    expect(await revertOf(stranger, 'claim', [key.address, recipient.address, forged])).toBe('BadSignature');
    expect(await revertOf(stranger, 'claim', [key.address, stranger.address, sig]), 'claimlink.recipient-bound-to-signature').toBe(
      'BadSignature',
    );
    // Anyone may submit the claim; the tokens go to the signed recipient.
    await write(stranger, escrow, CLAIM_ESCROW_ABI, 'claim', [key.address, recipient.address, sig]);
    expect(await balance(recipient.address)).toBe(amount);
    await invariant();
    expect(await revertOf(recipient, 'claim', [key.address, recipient.address, sig])).toBe('NotOpen');
    const read = await getClaimLink(pc, escrow, key.address);
    expect(read.link).toMatchObject({ state: 'claimed', amount: amount.toString(), claimedBy: recipient.address });
    expect(read.link.token).toMatchObject({ name: 'TEST Token A', decimals: 6 });
    await expect(getClaimLink(pc, escrow, stranger.address)).rejects.toMatchObject({ code: 'protocol.claim_link_not_found' });
  });

  it('claws back only for the sender and only after expiry; an expired link cannot be claimed', async () => {
    const amount = parseUnits('1', 6);
    const key = await createLink(amount);
    expect(await revertOf(sender, 'clawback', [key.address])).toBe('NotExpired');
    expect((await getClaimLink(pc, escrow, key.address)).link.state).toBe('open');
    await pc.request({ method: 'evm_increaseTime', params: [Number(MIN_EXPIRY) + 60] } as never);
    await pc.request({ method: 'evm_mine', params: [] } as never);
    const listed = await listClaimLinks(pc, escrow, sender.address);
    expect(listed.links[0]).toMatchObject({ id: key.address, state: 'expired' });
    expect(listed.links.map((link) => link.state)).toContain('claimed');
    const sig = await signClaim(key, key.address, recipient.address);
    expect(await revertOf(recipient, 'claim', [key.address, recipient.address, sig])).toBe('Expired');
    expect(await revertOf(stranger, 'clawback', [key.address])).toBe('NotSender');
    const before = await balance(sender.address);
    await write(sender, escrow, CLAIM_ESCROW_ABI, 'clawback', [key.address]);
    expect(await balance(sender.address)).toBe(before + amount);
    await invariant();
    expect((await getClaimLink(pc, escrow, key.address)).link.state).toBe('clawed_back');
    expect(await revertOf(sender, 'clawback', [key.address])).toBe('NotOpen');
  });

  describe('speed up and cancel', () => {
    afterAll(async () => {
      await pc.request({ method: 'evm_setAutomine', params: [true] } as never);
    });

    it('builds a same-nonce replacement for a pending transfer, then refuses once it is mined', async () => {
      await pc.request({ method: 'evm_setAutomine', params: [false] } as never);
      const data = encodeFunctionData({
        abi: loadArtifact('TestToken').abi,
        functionName: 'transfer',
        args: [recipient.address, 1n],
      });
      const original = await wallet(sender).sendTransaction({
        to: token,
        data,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        gas: 100_000n,
      });
      const pending = await pc.getTransaction({ hash: original });
      expect(pending.blockNumber).toBeNull();

      const speedUp = await buildReplacement(pc, SETTING, { txHash: original, from: sender.address, mode: 'speedUp' });
      expect(speedUp).toMatchObject({ nonce: pending.nonce, to: getAddress(token), data, value: '0' });
      expect(BigInt(speedUp.replacement.maxFeePerGas)).toBe(bumpFee(2_000_000_000n, 2000));
      expect(BigInt(speedUp.replacement.maxPriorityFeePerGas)).toBe(bumpFee(1_000_000_000n, 2000));
      expect(BigInt(speedUp.replacement.maxFeePerGas)).toBeGreaterThanOrEqual((2_000_000_000n * 12_000n) / 10_000n);

      const cancel = await buildReplacement(pc, SETTING, { txHash: original, from: sender.address, mode: 'cancel' });
      expect(cancel).toMatchObject({ nonce: pending.nonce, to: sender.address, value: '0', data: '0x' });

      await expect(buildReplacement(pc, SETTING, { txHash: original, from: stranger.address, mode: 'speedUp' })).rejects.toMatchObject({
        code: 'protocol.tx_not_yours',
      });
      await expect(
        buildReplacement(pc, { bumpBps: null, ceilingWei: 1n }, { txHash: original, from: sender.address, mode: 'speedUp' }),
      ).rejects.toMatchObject({ code: 'protocol.fee_bump_unset' });
      await expect(
        buildReplacement(pc, { bumpBps: 2000, ceilingWei: null }, { txHash: original, from: sender.address, mode: 'speedUp' }),
      ).rejects.toMatchObject({ code: 'protocol.fee_ceiling_unset' });
      await expect(
        buildReplacement(pc, { bumpBps: 2000, ceilingWei: 2_000_000_000n }, { txHash: original, from: sender.address, mode: 'speedUp' }),
      ).rejects.toMatchObject({ code: 'protocol.fee_above_ceiling' });

      // The person's wallet sends the replacement at the same nonce; the network keeps it and drops the original.
      const replaced = await wallet(sender).sendTransaction({
        to: speedUp.to as Address,
        data: speedUp.data as Hex,
        value: 0n,
        nonce: speedUp.nonce,
        gas: 100_000n,
        maxFeePerGas: BigInt(speedUp.replacement.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(speedUp.replacement.maxPriorityFeePerGas),
      });
      await pc.request({ method: 'evm_mine', params: [] } as never);
      const receipt = await pc.getTransactionReceipt({ hash: replaced });
      expect(receipt.status).toBe('success');
      await expect(pc.getTransaction({ hash: original })).rejects.toThrow();
      await expect(buildReplacement(pc, SETTING, { txHash: original, from: sender.address, mode: 'cancel' })).rejects.toMatchObject({
        code: 'protocol.tx_not_found',
      });
      const final = buildReplacement(pc, SETTING, { txHash: replaced, from: sender.address, mode: 'cancel' });
      await expect(final).rejects.toBeInstanceOf(WalletTxRefusal);
      await expect(final).rejects.toMatchObject({ code: 'protocol.tx_final' });
    });
  });
});

const CLAIM_ESCROW_ERRORS = [
  ...CLAIM_ESCROW_ABI,
  ...[
    'BadConfig',
    'BadLink',
    'LinkExists',
    'BadAmount',
    'ExpiryOutOfBounds',
    'NotOpen',
    'Expired',
    'NotExpired',
    'NotSender',
    'BadRecipient',
    'BadSignature',
    'TransferFailed',
    'Reentered',
  ].map((name) => ({ type: 'error' as const, name, inputs: [] })),
] as const;
