/**
 * MerchantAccept on-chain (S-A6) — payer → merchant (+ optional fee), no platform hardcode.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Address, Abi } from 'viem';
import { loadArtifact } from '../chain/artifacts.js';
import { keccak256, toBytes } from 'viem';

const WAD = 10n ** 18n;

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

describeOnChain('MerchantAccept on chain (S-A6)', () => {
  if (!devChainMod) return;

  let deployer: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let merchant: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let payer: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let fee: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let token: Address;
  let accept: Address;
  let tokenAbi: Abi;
  let acceptAbi: Abi;

  /**
   * A write counts once it is mined, and mined as a success. `writeContract` returns at submission: reading balances
   * straight after `pay` could see the merchant before the block and the fee after it (flaky #5728).
   */
  async function mined(client: typeof deployer, hash: `0x${string}`) {
    const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  }

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    deployer = await devChainMod.devSuiteClients(import.meta.url);
    merchant = await devChainMod.devSuiteClients(`${import.meta.url}#merchant`);
    payer = await devChainMod.devSuiteClients(`${import.meta.url}#payer`);
    fee = await devChainMod.devSuiteClients(`${import.meta.url}#fee`);

    const mock = loadArtifact('MockERC20');
    tokenAbi = mock.abi;
    const tTx = await deployer.walletClient.deployContract({
      abi: mock.abi,
      bytecode: mock.bytecode,
      account: deployer.walletClient.account!,
      chain: deployer.walletClient.chain,
    });
    token = (await mined(deployer, tTx)).contractAddress!;

    const m = loadArtifact('MerchantAccept');
    acceptAbi = m.abi;
    const mTx = await deployer.walletClient.deployContract({
      abi: m.abi,
      bytecode: m.bytecode,
      args: [merchant.deployer, fee.deployer, 100], // 1% merchant-chosen fee
      account: deployer.walletClient.account!,
      chain: deployer.walletClient.chain,
    });
    accept = (await mined(deployer, mTx)).contractAddress!;

    await mined(
      deployer,
      await deployer.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: 'mint',
        args: [payer.deployer, 100n * WAD],
        account: deployer.walletClient.account!,
        chain: deployer.walletClient.chain,
      }),
    );
  }, 120_000);

  it('splits payment to merchant + merchant-chosen fee recipient', async () => {
    const amount = 10n * WAD;
    await mined(
      payer,
      await payer.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: 'approve',
        args: [accept, amount],
        account: payer.walletClient.account!,
        chain: payer.walletClient.chain,
      }),
    );
    const paid = await mined(
      payer,
      await payer.walletClient.writeContract({
        address: accept,
        abi: acceptAbi,
        functionName: 'pay',
        args: [token, amount, keccak256(toBytes('inv-1'))],
        account: payer.walletClient.account!,
        chain: payer.walletClient.chain,
      }),
    );
    const mBal = (await deployer.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [merchant.deployer],
      blockNumber: paid.blockNumber,
    })) as bigint;
    const fBal = (await deployer.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [fee.deployer],
      blockNumber: paid.blockNumber,
    })) as bigint;
    expect(fBal).toBe(amount / 100n);
    expect(mBal).toBe(amount - amount / 100n);
  });
});
