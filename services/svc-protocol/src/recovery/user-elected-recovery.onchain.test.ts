/**
 * S-A1 / socket.social-recovery on-chain: user-elected M-of-N recovery.
 * Skips without anvil; CI with REQUIRE_EVM_CHAIN=1 must run this.
 *
 * Does not call evm_increaseTime — this suite shares one anvil with every other
 * on-chain file. Delay is proven by a long-delay instance that must still revert
 * executeRecovery without warping the node.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toBytes, type Address, type Abi, type Hex } from 'viem';
import { loadArtifact } from '../chain/artifacts.js';

const ERC1271_MAGIC = '0x1626ba7e';
/** Far enough that sibling suites' short warps cannot skip it. We never warp. */
const LONG_DELAY_SECONDS = 365 * 24 * 60 * 60;

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

describeOnChain('UserElectedRecovery on chain (S-A1)', () => {
  if (!devChainMod) return;

  let owner: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let guardianA: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let guardianB: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let successor: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let recoveryAbi: Abi;

  async function write(client: typeof owner, fn: () => Promise<`0x${string}`>) {
    const hash = await fn();
    await client.publicClient.waitForTransactionReceipt({ hash });
  }

  async function deployRecovery(ownerAddress: Address, delaySeconds: number): Promise<Address> {
    const artifact = loadArtifact('UserElectedRecovery');
    const tx = await owner.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [ownerAddress, delaySeconds],
      account: owner.walletClient.account!,
      chain: owner.walletClient.chain,
    });
    const receipt = await owner.publicClient.waitForTransactionReceipt({ hash: tx });
    if (!receipt.contractAddress) throw new Error('UserElectedRecovery deploy produced no address');
    return receipt.contractAddress;
  }

  async function electTwoOfTwo(instance: Address) {
    await write(owner, () =>
      owner.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'addGuardian',
        args: [guardianA.deployer],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    );
    await write(owner, () =>
      owner.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'addGuardian',
        args: [guardianB.deployer],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    );
    await write(owner, () =>
      owner.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'setThreshold',
        args: [2],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    );
  }

  async function guardianQuorum(instance: Address, newOwner: Address) {
    await write(guardianA, () =>
      guardianA.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'proposeRecovery',
        args: [newOwner],
        account: guardianA.walletClient.account!,
        chain: guardianA.walletClient.chain,
      }),
    );
    await write(guardianB, () =>
      guardianB.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'approveRecovery',
        args: [newOwner],
        account: guardianB.walletClient.account!,
        chain: guardianB.walletClient.chain,
      }),
    );
  }

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    owner = await devChainMod.devSuiteClients(import.meta.url);
    guardianA = await devChainMod.devSuiteClients(`${import.meta.url}#guardianA`);
    guardianB = await devChainMod.devSuiteClients(`${import.meta.url}#guardianB`);
    successor = await devChainMod.devSuiteClients(`${import.meta.url}#successor`);
    recoveryAbi = loadArtifact('UserElectedRecovery').abi;
  }, 180_000);

  it('owner adds two guardians, threshold 2, recovery rotates owner', async () => {
    const delayed = await deployRecovery(owner.deployer, LONG_DELAY_SECONDS);
    await electTwoOfTwo(delayed);
    await guardianQuorum(delayed, successor.deployer);
    await expect(
      owner.walletClient.writeContract({
        address: delayed,
        abi: recoveryAbi,
        functionName: 'executeRecovery',
        args: [],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    ).rejects.toThrow();

    const recovery = await deployRecovery(owner.deployer, 0);
    await electTwoOfTwo(recovery);
    await guardianQuorum(recovery, successor.deployer);
    await write(guardianA, () =>
      guardianA.walletClient.writeContract({
        address: recovery,
        abi: recoveryAbi,
        functionName: 'executeRecovery',
        args: [],
        account: guardianA.walletClient.account!,
        chain: guardianA.walletClient.chain,
      }),
    );

    const current = (await owner.publicClient.readContract({
      address: recovery,
      abi: recoveryAbi,
      functionName: 'owner',
    })) as Address;
    expect(current.toLowerCase()).toBe(successor.deployer.toLowerCase());

    const digest = keccak256(toBytes('user-elected-recovery-owner-op'));
    const successorAccount = successor.walletClient.account;
    const successorSign = successorAccount?.sign;
    if (!successorAccount || typeof successorSign !== 'function') throw new Error('successor cannot sign');
    const goodSig = await successorSign({ hash: digest });
    const magic = (await owner.publicClient.readContract({
      address: recovery,
      abi: recoveryAbi,
      functionName: 'isValidSignature',
      args: [digest, goodSig],
    })) as Hex;
    expect(magic.toLowerCase()).toBe(ERC1271_MAGIC);

    const ownerAccount = owner.walletClient.account;
    const ownerSign = ownerAccount?.sign;
    if (!ownerAccount || typeof ownerSign !== 'function') throw new Error('owner cannot sign');
    const staleSig = await ownerSign({ hash: digest });
    const stale = (await owner.publicClient.readContract({
      address: recovery,
      abi: recoveryAbi,
      functionName: 'isValidSignature',
      args: [digest, staleSig],
    })) as Hex;
    expect(stale.toLowerCase()).not.toBe(ERC1271_MAGIC);
  }, 60_000);

  it('owner can revoke a guardian before recovery completes', async () => {
    const instance = await deployRecovery(owner.deployer, 0);
    await electTwoOfTwo(instance);
    await guardianQuorum(instance, successor.deployer);

    await write(owner, () =>
      owner.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'removeGuardian',
        args: [guardianB.deployer],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    );

    await expect(
      guardianA.walletClient.writeContract({
        address: instance,
        abi: recoveryAbi,
        functionName: 'executeRecovery',
        args: [],
        account: guardianA.walletClient.account!,
        chain: guardianA.walletClient.chain,
      }),
    ).rejects.toThrow();

    const current = (await owner.publicClient.readContract({
      address: instance,
      abi: recoveryAbi,
      functionName: 'owner',
    })) as Address;
    expect(current.toLowerCase()).toBe(owner.deployer.toLowerCase());
  }, 60_000);

  it('recovery with zero guardians cannot run', async () => {
    const empty = await deployRecovery(owner.deployer, 0);
    await expect(
      guardianA.walletClient.writeContract({
        address: empty,
        abi: recoveryAbi,
        functionName: 'proposeRecovery',
        args: [successor.deployer],
        account: guardianA.walletClient.account!,
        chain: guardianA.walletClient.chain,
      }),
    ).rejects.toThrow();

    await expect(
      owner.walletClient.writeContract({
        address: empty,
        abi: recoveryAbi,
        functionName: 'executeRecovery',
        args: [],
        account: owner.walletClient.account!,
        chain: owner.walletClient.chain,
      }),
    ).rejects.toThrow();
  }, 60_000);
});
