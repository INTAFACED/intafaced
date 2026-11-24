import { describe, expect, it, vi } from 'vitest';
import { MemoryBroadcastStore, type BroadcastStore } from './broadcast-store.js';
import { runDurableBroadcast } from './durable-broadcast.js';

function trackingStore(inner: MemoryBroadcastStore): { store: BroadcastStore; order: string[] } {
  const order: string[] = [];
  return {
    order,
    store: {
      get: (k) => inner.get(k),
      hasSigned: (k) => inner.hasSigned(k),
      close: (k) => inner.close(k),
      claim: (k) => inner.claim(k),
      putSigned: async (k, raw) => {
        order.push('putSigned');
        await inner.putSigned(k, raw);
      },
      put: async (k, h) => {
        order.push('put');
        return inner.put(k, h);
      },
    },
  };
}

/**
 * Public door for D26-P1-P9: this path fails closed if putSigned is skipped
 * before broadcast — crash-resume would then re-sign a second spend.
 */
describe('runDurableBroadcast — signed persist before send (D26-P1-P9)', () => {
  it('fails if broadcast() is invoked before putSigned on a fresh claim', async () => {
    const inner = new MemoryBroadcastStore();
    const { store, order } = trackingStore(inner);
    const signedRaw = '0xsigneddeadbeef';

    const hash = await runDurableBroadcast({
      store,
      idempotencyKey: 'payout:d26:1',
      sign: async () => signedRaw,
      broadcast: async (raw) => {
        order.push('broadcast');
        expect(order.indexOf('putSigned')).toBe(0);
        expect(order.indexOf('broadcast')).toBeGreaterThan(order.indexOf('putSigned'));
        expect(await inner.hasSigned('payout:d26:1')).toBe(true);
        expect(raw).toBe(signedRaw);
        return '0xhash1';
      },
    });

    expect(hash).toBe('0xhash1');
    expect(order.slice(0, 2)).toEqual(['putSigned', 'broadcast']);
    expect(await inner.get('payout:d26:1')).toBe('0xhash1');
  });

  it('crash between putSigned and put resumes identical signed raw without sign()', async () => {
    const store = new MemoryBroadcastStore();
    const signedRaw = '0xsignedcrashresume';
    const sign = vi.fn(async () => signedRaw);

    await expect(
      runDurableBroadcast({
        store,
        idempotencyKey: 'payout:d26:crash',
        sign,
        broadcast: async (raw) => {
          expect(raw).toBe(signedRaw);
          expect(await store.hasSigned('payout:d26:crash')).toBe(true);
          throw new Error('simulated crash after persist before put');
        },
      }),
    ).rejects.toThrow(/simulated crash after persist before put/);

    expect(sign).toHaveBeenCalledTimes(1);
    sign.mockClear();

    await expect(
      runDurableBroadcast({
        store,
        idempotencyKey: 'payout:d26:crash',
        sign,
        broadcast: async (raw) => {
          expect(raw).toBe(signedRaw);
          return '0xrecovered';
        },
      }),
    ).resolves.toBe('0xrecovered');

    expect(sign).not.toHaveBeenCalled();
    expect(await store.get('payout:d26:crash')).toBe('0xrecovered');
  });

  it('refuses RPC when hasSigned is false (putSigned skipped)', async () => {
    const inner = new MemoryBroadcastStore();
    const broadcast = vi.fn(async () => '0xshould-not');
    const store: BroadcastStore = {
      get: (k) => inner.get(k),
      hasSigned: async () => false,
      close: (k) => inner.close(k),
      claim: (k) => inner.claim(k),
      putSigned: async (k, raw) => inner.putSigned(k, raw),
      put: (k, h) => inner.put(k, h),
    };

    await expect(
      runDurableBroadcast({
        store,
        idempotencyKey: 'payout:d26:skip',
        sign: async () => '0xraw',
        broadcast,
      }),
    ).rejects.toThrow(/putSigned must precede RPC/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('done claim returns existing hash and must not broadcast again', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('payout:d26:done');
    await store.putSigned('payout:d26:done', '0xraw');
    await store.put('payout:d26:done', '0xsettled');

    const sign = vi.fn(async () => '0xnew');
    const broadcast = vi.fn(async () => '0xother');

    await expect(
      runDurableBroadcast({
        store,
        idempotencyKey: 'payout:d26:done',
        sign,
        broadcast,
      }),
    ).resolves.toBe('0xsettled');
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
