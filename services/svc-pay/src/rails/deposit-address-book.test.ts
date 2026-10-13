import { describe, expect, it } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { MemoryDepositAddressBook } from './deposit-address-book.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain, stableDepositIndex } from './evm-chain.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

/**
 * Two payment ids whose stable HD slot is the same. The collision walk is
 * the path that used to depend on the process map.
 */
function collidingPayments(assetId: string): { owner: string; other: string } {
  const seen = new Map<number, string>();
  for (let n = 0; n < 400_000; n++) {
    const id = `l318-${n}`;
    const index = stableDepositIndex(id, assetId);
    const prev = seen.get(index);
    if (prev) return { owner: prev, other: id };
    seen.set(index, id);
  }
  throw new Error('no deposit-index collision in the search window');
}

function chain(book: MemoryDepositAddressBook): EvmLiveChain {
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

describe('EvmLiveChain deposit address book', () => {
  it('a second chain instance sharing the durable store returns the same address and refuses to hand it to a different payment', async () => {
    const { owner, other } = collidingPayments('ETH');
    expect(stableDepositIndex(owner, 'ETH')).toBe(stableDepositIndex(other, 'ETH'));

    const book = new MemoryDepositAddressBook();
    const shown = await chain(book).acceptanceAddress(owner, 'ETH');

    // New instance: empty process maps, same book. The colliding payment is
    // asked first — a cleared map would return the owner's base address.
    const restarted = chain(book);
    const walked = await restarted.acceptanceAddress(other, 'ETH');
    expect(walked).not.toBe(shown);
    expect(await restarted.acceptanceAddress(owner, 'ETH')).toBe(shown);

    const again = chain(book);
    expect(await again.acceptanceAddress(owner, 'ETH')).toBe(shown);
    expect(await again.acceptanceAddress(other, 'ETH')).toBe(walked);
    expect(await again.acceptanceAddress(other, 'ETH')).not.toBe(shown);
  });
});
