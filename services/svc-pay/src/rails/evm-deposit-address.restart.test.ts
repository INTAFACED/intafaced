import { TestnetSigner } from './evm-signer.js';
import { describe, expect, it } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain, stableDepositIndex } from './evm-chain.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const mk = () =>
  new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    depositMnemonic: MNEMONIC,
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 1,
  });

describe('a deposit address is a function of the payment, not of the order they were requested in', () => {
  it('a payment keeps its address after a new process sees colliding payments in another order', async () => {
    const seen = new Map<number, string>();
    let a = '',
      b = '';
    for (let i = 0; i < 400_000 && !b; i++) {
      const id = `p${i}`;
      const idx = stableDepositIndex(id, 'ETH');
      const prev = seen.get(idx);
      if (prev) {
        a = prev;
        b = id;
      } else seen.set(idx, id);
    }
    expect(b).not.toBe('');
    const first = mk();
    await first.acceptanceAddress(a, 'ETH');
    const bBefore = await first.acceptanceAddress(b, 'ETH');
    const restarted = mk();
    const aAfter = await restarted.acceptanceAddress(a, 'ETH');
    // restart: b is requested first this time
    const restarted2 = mk();
    await restarted2.acceptanceAddress(b, 'ETH');
    const aAfter2 = await restarted2.acceptanceAddress(a, 'ETH');
    expect(aAfter2).toBe(aAfter);
    expect(await restarted2.acceptanceAddress(b, 'ETH')).toBe(bBefore);
  }, 120_000);
});
