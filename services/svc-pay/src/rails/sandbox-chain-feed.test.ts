import { describe, expect, it } from 'vitest';
import { MemoryChain, UnconfiguredChain } from './chain-port.js';
import type { RailEvent } from './rail-adapter.js';
import { feedSandboxChain } from './sandbox-chain-feed.js';

const captured = (over: Partial<RailEvent> = {}): RailEvent =>
  ({
    railId: 'crypto-native',
    eventId: 'chain:0xabc:addr_usdc_p1:0',
    type: 'captured',
    railRef: 'addr_usdc_p1',
    amount: 25_000_000_000_000_000_000n,
    assetId: 'USDC',
    occurredAt: new Date('2026-10-24T22:00:00Z'),
    chain: { txHash: '0xabc', logIndex: 0, confirmations: 12 },
    ...over,
  }) as RailEvent;

describe('feeding the in-memory chain from a verified delivery', () => {
  it('records the transfer so the rail reads it back, deepens it, and never makes it shallower', async () => {
    const chain = new MemoryChain();
    expect(await feedSandboxChain(chain, captured({ chain: { txHash: '0xabc', logIndex: 0, confirmations: 1 } }))).toBe(true);
    expect(await chain.inboundTransfer('addr_usdc_p1')).toMatchObject({ txHash: '0xabc', assetId: 'USDC', confirmations: 1 });
    expect(await feedSandboxChain(chain, captured())).toBe(true);
    expect(await chain.inboundTransfer('addr_usdc_p1')).toMatchObject({ amount: 25_000_000_000_000_000_000n, confirmations: 12 });
    // A late redelivery of the shallower event changes nothing.
    expect(await feedSandboxChain(chain, captured({ chain: { txHash: '0xabc', logIndex: 0, confirmations: 1 } }))).toBe(false);
    expect((await chain.inboundTransfer('addr_usdc_p1'))?.confirmations).toBe(12);
  });

  it('records no payer address, so a refund cannot go to an invented one', async () => {
    const chain = new MemoryChain();
    await feedSandboxChain(chain, captured());
    expect((await chain.inboundTransfer('addr_usdc_p1'))?.from).toBe('');
  });

  it('takes the confirmations of a reorged transfer away, and only of that transfer', async () => {
    const chain = new MemoryChain();
    await feedSandboxChain(chain, captured());
    const reorg = (txHash: string) =>
      captured({ type: 'chain.reorged', amount: undefined, chain: { txHash, logIndex: 0, confirmations: 0 } });
    expect(await feedSandboxChain(chain, reorg('0xother'))).toBe(false);
    expect((await chain.inboundTransfer('addr_usdc_p1'))?.confirmations).toBe(12);
    expect(await feedSandboxChain(chain, reorg('0xabc'))).toBe(true);
    expect((await chain.inboundTransfer('addr_usdc_p1'))?.confirmations).toBe(0);
  });

  it('records nothing for a refused delivery, another event type, a delivery without a transfer, or any other chain', async () => {
    const chain = new MemoryChain();
    expect(await feedSandboxChain(chain, null)).toBe(false);
    expect(await feedSandboxChain(chain, captured({ type: 'failed' }))).toBe(false);
    expect(await feedSandboxChain(chain, captured({ chain: undefined }))).toBe(false);
    expect(await feedSandboxChain(chain, captured({ amount: 0n }))).toBe(false);
    expect(await feedSandboxChain(chain, captured({ assetId: undefined }))).toBe(false);
    expect(await chain.inboundTransfer('addr_usdc_p1')).toBeNull();
    expect(await feedSandboxChain(new UnconfiguredChain(), captured())).toBe(false);
  });
});
