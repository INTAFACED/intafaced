import { TestnetSigner } from './evm-signer.js';
import { describe, expect, it, vi } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';
import { restoreOpenDepositWatches } from './watch-restore.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const mk = () =>
  new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    depositMnemonic: MNEMONIC,
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 1,
  });

/** A node whose only activity is one native deposit in block 1. */
function installDeposit(chain: EvmLiveChain, to: string) {
  const hash = `0x${'ab'.repeat(32)}` as const;
  (chain as unknown as { public: unknown }).public = {
    getBlockNumber: async () => 3n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      transactions:
        blockNumber === 1n
          ? [{ to, from: '0x0000000000000000000000000000000000000001', value: 10n ** 16n, hash, transactionIndex: 0 }]
          : [],
    }),
    getLogs: async () => [],
    getTransactionReceipt: async () => ({ status: 'success', transactionHash: hash, blockNumber: 1n, logs: [] }),
  };
  return hash;
}

describe('a restart does not stop watching payments that are waiting for a deposit', () => {
  it('a restarted chain sees the deposit to an open payment only after its watch is restored', async () => {
    const before = mk();
    const address = await before.acceptanceAddress('pay-open-1', 'ETH');

    const restarted = mk();
    installDeposit(restarted, address);
    const log = vi.fn();
    const restored = await restoreOpenDepositWatches(restarted, async () => [{ paymentId: 'pay-open-1', assetId: 'ETH' }], log);
    expect(restored).toBe(1);
    await restarted.refresh();
    expect(await restarted.inboundTransfer(address)).toMatchObject({ assetId: 'ETH' });
  });

  it('without a restore the restarted chain watches nothing', async () => {
    const address = await mk().acceptanceAddress('pay-open-2', 'ETH');
    const restarted = mk();
    installDeposit(restarted, address);
    expect(await restarted.inboundTransfer(address)).toBeNull();
  });

  it('skips a payment whose asset is gone and still restores the rest', async () => {
    const chain = mk();
    const log = vi.fn();
    const restored = await restoreOpenDepositWatches(
      chain,
      async () => [
        { paymentId: 'a', assetId: 'DOGE' },
        { paymentId: 'b', assetId: 'ETH' },
      ],
      log,
    );
    expect(restored).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
