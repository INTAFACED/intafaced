import { describe, expect, it } from 'vitest';
import { CryptoNativeAdapter } from './crypto-native.js';
import { MemoryChain } from './chain-port.js';

const SECRET = 'x'.repeat(32);
const adapter = () => new CryptoNativeAdapter({ chain: new MemoryChain(), secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
const base = { id: 'chain:0xabc:0xaddr:3', type: 'captured', ref: '0xaddr', amount: '25', assetId: 'USDT' };

describe('crypto-native webhook chain position (W-deposit-05)', () => {
  it('carries tx hash, log index and depth when the watcher sent them', () => {
    const a = adapter();
    const event = a.verifyWebhook(a.signWebhook({ ...base, txHash: '0xabc', logIndex: 3, confirmations: 12 }));
    expect(event?.chain).toEqual({ txHash: '0xabc', logIndex: 3, confirmations: 12 });
  });

  it('leaves chain absent when any part is missing or malformed, so nothing is booked from a guess', () => {
    const a = adapter();
    for (const extra of [
      {},
      { txHash: '0xabc', logIndex: 3 },
      { txHash: '0xabc', logIndex: -1, confirmations: 1 },
      { txHash: '0xabc', logIndex: 1.5, confirmations: 1 },
      { txHash: '', logIndex: 0, confirmations: 1 },
    ]) {
      expect(a.verifyWebhook(a.signWebhook({ ...base, ...extra }))?.chain).toBeUndefined();
    }
  });
});

describe('crypto-native webhook chain reorg (W-deposit-06)', () => {
  it('a reorg names the transfer it takes back by chain position', () => {
    const a = adapter();
    const event = a.verifyWebhook(
      a.signWebhook({ id: 'reorg:0xabc:0xaddr:3', type: 'chain.reorged', ref: '0xaddr', txHash: '0xabc', logIndex: 3, confirmations: 0 }),
    );
    expect(event?.type).toBe('chain.reorged');
    expect(event?.chain).toEqual({ txHash: '0xabc', logIndex: 3, confirmations: 0 });
  });

  it('a reorg without a chain position is not an event at all', () => {
    const a = adapter();
    for (const extra of [{}, { txHash: '0xabc', logIndex: 3 }, { txHash: '', logIndex: 3, confirmations: 0 }]) {
      expect(a.verifyWebhook(a.signWebhook({ id: 'reorg:x', type: 'chain.reorged', ref: '0xaddr', ...extra }))).toBeNull();
    }
  });
});
