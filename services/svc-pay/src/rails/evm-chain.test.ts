import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { MemoryDepositAddressBook } from './deposit-address-book.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';

/**
 * L320. No chain node: the public client is a stub.
 *
 * An empty first refresh must leave the 2000-block lookback in place. An
 * address registered during an awaited getBlock must be visible on a later
 * block of that same scan.
 */

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PAYER = '0x0000000000000000000000000000000000000001';
const LOOKBACK = 2_000n;

type NativeTx = {
  to: string;
  from: string;
  value: bigint;
  hash: Hex;
  transactionIndex: number;
};

function block(number: bigint, transactions: NativeTx[] = []) {
  return { number, transactions };
}

function scanCursorOf(chain: EvmLiveChain): bigint {
  return (chain as unknown as { scanCursor: bigint }).scanCursor;
}

function installRpc(
  chain: EvmLiveChain,
  rpc: {
    getBlockNumber: () => Promise<bigint>;
    getBlock: (args: { blockNumber: bigint }) => Promise<{ number: bigint; transactions: NativeTx[] }>;
  },
): void {
  (chain as unknown as { public: typeof rpc }).public = rpc;
}

function chainWith(book: MemoryDepositAddressBook): EvmLiveChain {
  return new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    depositMnemonic: MNEMONIC,
    hotWalletKey: HOT_KEY,
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    depositAddresses: book,
    minConfirmations: 1,
  });
}

describe('EvmLiveChain deposit scan cursor', () => {
  it('leaves the lookback cursor when the first refresh has no addresses, and sees an address added during the scan', async () => {
    const emptyBook = new MemoryDepositAddressBook();
    const emptyChain = chainWith(emptyBook);
    const tip = 2_500n;
    const lookbackCursor = tip - LOOKBACK;
    const earlyHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
    const earlyValue = parseAmount('0.05');
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber));
    installRpc(emptyChain, {
      getBlockNumber: async () => tip,
      getBlock,
    });

    await emptyChain.refresh();

    expect(getBlock).not.toHaveBeenCalled();
    expect(scanCursorOf(emptyChain)).toBe(lookbackCursor);

    const lateAddress = await emptyChain.acceptanceAddress('pay-registered-after-restart', 'ETH');
    getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber !== lookbackCursor) return block(blockNumber);
      return block(blockNumber, [
        {
          to: lateAddress,
          from: PAYER,
          value: earlyValue,
          hash: earlyHash,
          transactionIndex: 0,
        },
      ]);
    });

    const early = await emptyChain.inboundTransfer(lateAddress);
    expect(getBlock.mock.calls[0]?.[0]).toMatchObject({ blockNumber: lookbackCursor });
    expect(early).toMatchObject({ txHash: earlyHash, assetId: 'ETH', amount: earlyValue });
    expect(typeof early?.amount).toBe('bigint');
    const storedLate = await emptyBook.findByPayment('pay-registered-after-restart', 'ETH');
    expect(storedLate?.address.toLowerCase()).toBe(lateAddress.toLowerCase());

    const midBook = new MemoryDepositAddressBook();
    const midChain = chainWith(midBook);
    const midTip = 4n;
    const midHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
    const midValue = parseAmount('0.2');
    let added = '';
    const addedAt = 0n;
    const depositAt = 3n;
    installRpc(midChain, {
      getBlockNumber: async () => midTip,
      getBlock: async ({ blockNumber }) => {
        if (blockNumber === addedAt) {
          added = await midChain.acceptanceAddress('pay-added-during-scan', 'ETH');
          return block(blockNumber);
        }
        if (blockNumber === depositAt) {
          return block(blockNumber, [
            {
              to: added,
              from: PAYER,
              value: midValue,
              hash: midHash,
              transactionIndex: 2,
            },
          ]);
        }
        return block(blockNumber);
      },
    });

    await midChain.acceptanceAddress('pay-already-watched', 'ETH');
    await midChain.refresh();

    expect(added).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(depositAt > addedAt).toBe(true);
    const storedAdded = await midBook.findByPayment('pay-added-during-scan', 'ETH');
    expect(storedAdded?.address.toLowerCase()).toBe(added.toLowerCase());
    const mid = await midChain.inboundTransfer(added);
    expect(mid).toMatchObject({ txHash: midHash, assetId: 'ETH', amount: midValue });
    expect(typeof mid?.amount).toBe('bigint');
  });
});
