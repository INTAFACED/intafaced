import { describe, expect, it } from 'vitest';
import type { Transport } from 'viem';
import { withGasHeadroom } from './dev-chain.js';

const stub = (answers: Record<string, string>): Transport =>
  (() => ({
    config: { key: 'stub', name: 'stub', request: async () => null, retryCount: 0, retryDelay: 0, timeout: 1, type: 'stub' },
    request: async ({ method }: { method: string }) => answers[method],
    value: undefined,
  })) as unknown as Transport;

describe('withGasHeadroom', () => {
  // The lending market does more work once the block timestamp has moved, so a bare estimate made in the same
  // second as the previous block runs out of gas when the real block lands a second later.
  it('doubles an eth_estimateGas answer', async () => {
    const t = withGasHeadroom(stub({ eth_estimateGas: '0x19a04' }))({ chain: undefined });
    expect(await t.request({ method: 'eth_estimateGas' })).toBe('0x33408');
  });

  it('leaves every other answer untouched', async () => {
    const t = withGasHeadroom(stub({ eth_blockNumber: '0x10', eth_chainId: '0x7a69' }))({ chain: undefined });
    expect(await t.request({ method: 'eth_blockNumber' })).toBe('0x10');
    expect(await t.request({ method: 'eth_chainId' })).toBe('0x7a69');
  });
});
