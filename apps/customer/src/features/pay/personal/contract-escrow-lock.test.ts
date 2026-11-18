import { describe, expect, it, vi } from 'vitest';
import { attachWhenLocked } from './contract-escrow-lock';

// The seller's lock is attached to the order only once its receipt says success.
const lockHash = '0xlock';

describe('attachWhenLocked', () => {
  it('a reverted lock (status 0x0) is not attached and says it reverted', async () => {
    const attach = vi.fn(async () => ({ ok: true as const }));
    const outcome = await attachWhenLocked({ readReceipt: async () => ({ status: '0x0' }), lockHash, attach, timeoutMs: 1_000 });
    expect(outcome).toEqual({ kind: 'reverted' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('a lock with no receipt before the timeout is not attached and stays pending', async () => {
    const attach = vi.fn(async () => ({ ok: true as const }));
    const outcome = await attachWhenLocked({ readReceipt: async () => null, lockHash, attach, timeoutMs: 600 });
    expect(outcome).toEqual({ kind: 'pending' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('a mined lock (status 0x1) is attached', async () => {
    const attach = vi.fn(async () => ({ ok: true as const }));
    const outcome = await attachWhenLocked({
      readReceipt: async () => ({ status: '0x1', blockNumber: '0x5' }),
      lockHash,
      attach,
      timeoutMs: 1_000,
    });
    expect(outcome).toEqual({ kind: 'attached' });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('a mined lock the order refuses carries the order’s own reason', async () => {
    const attach = vi.fn(async () => ({ ok: false as const, code: 'p2p.deal_not_locked', message: 'the deal is not locked' }));
    const outcome = await attachWhenLocked({ readReceipt: async () => ({ status: '0x1' }), lockHash, attach, timeoutMs: 1_000 });
    expect(outcome).toEqual({ kind: 'refused', message: 'the deal is not locked' });
  });
});
