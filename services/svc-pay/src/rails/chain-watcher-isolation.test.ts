import { describe, expect, it, vi } from 'vitest';
import {
  CryptoChainWatcher,
  MemoryChainWatcherCursorStore,
  MemoryChainWatcherDeadLetterStore,
  type ChainWatcherChain,
} from './chain-watcher.js';
import type { FinalizedInbound } from './evm-chain.js';

/**
 * One failed delivery must not stop the watcher for everyone else.
 *
 * Before: the first non-2xx (or a thrown fetch) ended the tick, so every later inbound, for every other merchant's
 * address, waited behind it. The delivery id was `chain:<tx>:<address>`, so two logs of one transaction to one
 * address shared an id and the second was dropped as a duplicate at the book.
 */
const SECRET = 'x'.repeat(32);
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';

function inbound(address: string, txHash: string, blockNumber: bigint, logIndex: number): FinalizedInbound {
  return {
    address,
    transfer: {
      txHash: txHash as `0x${string}`,
      assetId: 'USDT',
      amount: 1_000_000n,
      from: '0x1111111111111111111111111111111111111111',
      confirmations: 6,
    },
    blockNumber,
    logIndex,
  };
}

/** Same marking rule as EvmLiveChain: one call marks the earliest unmarked inbound at that address. */
function fakeChain(items: FinalizedInbound[]): ChainWatcherChain & { marked: string[] } {
  const done = new Set<FinalizedInbound>();
  const marked: string[] = [];
  return {
    marked,
    refresh: async () => undefined,
    drainFinalized: () => items.filter((i) => !done.has(i)),
    markFinalizedEmitted: (address) => {
      marked.push(address);
      const first = items.find((i) => !done.has(i) && i.address.toLowerCase() === address.toLowerCase());
      if (first) done.add(first);
    },
  };
}

function bodyOf(call: unknown[]): { id: string; ref: string } {
  return JSON.parse((call[1] as { body: string }).body) as { id: string; ref: string };
}

function watcherFor(
  chain: ChainWatcherChain,
  fetchImpl: unknown,
  extra: Partial<ConstructorParameters<typeof CryptoChainWatcher>[0]> = {},
) {
  return new CryptoChainWatcher({
    chain,
    secret: SECRET,
    webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
    fetchImpl: fetchImpl as typeof fetch,
    cursorStore: new MemoryChainWatcherCursorStore(),
    ...extra,
  });
}

describe('CryptoChainWatcher — per-address isolation', () => {
  it('a rejected delivery for one address does not stop the others in the same tick', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0), inbound(B, '0xbb', 11n, 0), inbound(C, '0xcc', 12n, 0)]);
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const { ref } = JSON.parse((init as { body: string }).body) as { ref: string };
      return new Response('no', { status: ref === A ? 500 : 200 });
    });
    await watcherFor(chain, fetchImpl).tick();
    expect(fetchImpl.mock.calls.map((c) => bodyOf(c).ref)).toEqual([A, B, C]);
    expect(chain.marked).toEqual([B, C]);
  });

  it('a thrown fetch for one address does not stop the others', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0), inbound(B, '0xbb', 11n, 0)]);
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const { ref } = JSON.parse((init as { body: string }).body) as { ref: string };
      if (ref === A) throw new Error('socket hang up');
      return new Response('ok', { status: 200 });
    });
    await watcherFor(chain, fetchImpl).tick();
    expect(chain.marked).toEqual([B]);
  });

  it('later inbounds at a failed address wait behind it (the book sees them in order)', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0), inbound(A, '0xab', 11n, 0), inbound(B, '0xbb', 12n, 0)]);
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const b = JSON.parse((init as { body: string }).body) as { ref: string; txHash: string };
      return new Response('no', { status: b.txHash === '0xaa' ? 500 : 200 });
    });
    await watcherFor(chain, fetchImpl).tick();
    expect(fetchImpl.mock.calls.map((c) => (JSON.parse((c[1] as { body: string }).body) as { txHash: string }).txHash)).toEqual([
      '0xaa',
      '0xbb',
    ]);
    expect(chain.marked).toEqual([B]);
  });

  it('the cursor never passes a failed position, so a restart retries it', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0), inbound(B, '0xbb', 11n, 0)]);
    const cursors = new MemoryChainWatcherCursorStore();
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const { ref } = JSON.parse((init as { body: string }).body) as { ref: string };
      return new Response('no', { status: ref === A ? 500 : 200 });
    });
    await watcherFor(chain, fetchImpl, { cursorStore: cursors }).tick();
    expect(await cursors.load('crypto-native')).toBeNull();
  });
});

describe('CryptoChainWatcher — delivery id', () => {
  it('names the log index so two logs of one transaction to one address have different ids', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 3), inbound(A, '0xaa', 10n, 7)]);
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    await watcherFor(chain, fetchImpl).tick();
    const ids = fetchImpl.mock.calls.map((c) => bodyOf(c as unknown[]).id);
    expect(ids).toEqual([`chain:0xaa:${A}:3`, `chain:0xaa:${A}:7`]);
    expect(new Set(ids).size).toBe(2);
  });

  it('a retry of the same inbound keeps the same id', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 3)]);
    let n = 0;
    const fetchImpl = vi.fn(async () => new Response('x', { status: ++n === 1 ? 500 : 200 }));
    const watcher = watcherFor(chain, fetchImpl);
    await watcher.tick();
    await watcher.tick();
    expect(bodyOf(fetchImpl.mock.calls[0] as unknown[]).id).toBe(bodyOf(fetchImpl.mock.calls[1] as unknown[]).id);
  });
});

describe('CryptoChainWatcher — dead letter', () => {
  it('with no attempt limit published nothing is dead-lettered and the failure is retried forever', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0)]);
    const deadLetters = new MemoryChainWatcherDeadLetterStore();
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const watcher = watcherFor(chain, fetchImpl, { deadLetters });
    for (let i = 0; i < 5; i += 1) await watcher.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(await deadLetters.list()).toEqual([]);
    expect(chain.marked).toEqual([]);
  });

  it('after the published number of attempts it records a dead letter, frees the address and moves on', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 3), inbound(A, '0xab', 11n, 0)]);
    const deadLetters = new MemoryChainWatcherDeadLetterStore();
    const cursors = new MemoryChainWatcherCursorStore();
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const b = JSON.parse((init as { body: string }).body) as { txHash: string };
      return new Response('no', { status: b.txHash === '0xaa' ? 502 : 200 });
    });
    const watcher = watcherFor(chain, fetchImpl, { deadLetters, cursorStore: cursors, maxDeliveryAttempts: 3 });
    await watcher.tick();
    await watcher.tick();
    expect(await deadLetters.list()).toEqual([]);
    await watcher.tick();
    expect(await deadLetters.list()).toEqual([
      expect.objectContaining({
        deliveryId: `chain:0xaa:${A}:3`,
        address: A,
        txHash: '0xaa',
        logIndex: 3,
        blockNumber: '10',
        attempts: 3,
        lastStatus: 502,
      }),
    ]);
    // the next inbound at that address is delivered on the same or the following tick
    await watcher.tick();
    expect(chain.marked).toEqual([A, A]);
    expect((await cursors.load('crypto-native'))?.txHash).toBe('0xab');
  });

  it('a dead letter that cannot be recorded keeps the inbound pending', async () => {
    const chain = fakeChain([inbound(A, '0xaa', 10n, 0)]);
    const deadLetters = new MemoryChainWatcherDeadLetterStore();
    deadLetters.record = async () => {
      throw new Error('db down');
    };
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const watcher = watcherFor(chain, fetchImpl, { deadLetters, maxDeliveryAttempts: 1 });
    await watcher.tick();
    await watcher.tick();
    expect(chain.marked).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('CryptoChainWatcher — dropped inbounds (W-deposit-06)', () => {
  it('reports what the chain no longer shows, and a throwing report does not stop delivery', async () => {
    const delivered = inbound(A, '0xaa', 10n, 0);
    const gone = inbound(B, '0xbb', 11n, 3);
    const chain = { ...fakeChain([delivered]), droppedInbound: () => [gone] } as ChainWatcherChain & { marked: string[] };
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    await watcherFor(chain, fetchImpl, {
      onDropped: async (items) => {
        seen.push(...items.map((i) => `${i.address}:${i.transfer.txHash}:${i.logIndex}`));
        throw new Error('report failed');
      },
    }).tick();
    expect(seen).toEqual([`${B}:0xbb:3`]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(chain.marked).toEqual([A]);
  });

  it('a chain without droppedInbound reports nothing', async () => {
    const onDropped = vi.fn(async () => undefined);
    await watcherFor(fakeChain([]), vi.fn(), { onDropped }).tick();
    expect(onDropped).not.toHaveBeenCalled();
  });
});
