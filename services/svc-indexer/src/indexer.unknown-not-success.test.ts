import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client/money';
import { MemoryChainSource } from './chain/memory-source.js';
import type { ChainBlock, ChainSource } from './chain/source.js';
import { Indexer, MissingBlockError } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { createIndexerRouter } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';

/**
 * PTX-M06 / PTX-M22-R07 — a missing, reorg'd, or unconfirmed chain event is
 * not a fill and not a successful projection. Unknown ≠ success.
 */

const EDGE_SECRET = 'a-indexer-unknown-not-success-edge-secret-long';
const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WIRED_VENUE = '0x1111111111111111111111111111111111111111';

function anonymous() {
  return createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-indexer' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-unknown-not-success',
  });
}

function fillAt(logIndex: number, quantity: string) {
  return {
    kind: 'fill' as const,
    logIndex,
    market: 'IFC-USD',
    price: '100',
    quantity,
    takerSide: 'buy' as const,
    maker: MAKER,
    taker: TAKER,
  };
}

function gapped(base: MemoryChainSource, hole: number): ChainSource {
  return {
    chainId: base.chainId,
    head: () => base.head(),
    blockAt: async (height: number): Promise<ChainBlock | null> => (height === hole ? null : base.blockAt(height)),
  };
}

describe('Indexer · missing block is not caught-up and not a fill', () => {
  it('throws MissingBlockError when the successor is a hole and the tip is ahead', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([fillAt(0, '1')]);
    source.appendEmpty(2);

    const warm = new Indexer({
      source,
      store,
      finalityDepth: 64,
      batchSize: 50,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    await warm.sync();
    expect((await store.head())?.height).toBe(2);
    expect(await store.recentFills('IFC-USD', 10)).toHaveLength(1);

    source.appendEmpty(3); // tip 5, hole will hide 3
    const indexer = new Indexer({
      source: gapped(source, 3),
      store,
      finalityDepth: 64,
      batchSize: 50,
      ingestEnabled: () => true,
      startHeight: 0,
    });

    await expect(indexer.sync()).rejects.toBeInstanceOf(MissingBlockError);
    expect(indexer.lastError?.code).toBe('indexer.block_missing');
    expect(indexer.halted).toBeNull();
    expect((await store.head())?.height).toBe(2);
    // Did not skip the hole and project a later block as a successful fill.
    expect(await store.blockAt(4)).toBeNull();
    expect(await store.blockAt(5)).toBeNull();
    expect(await store.recentFills('IFC-USD', 10)).toHaveLength(1);
  });

  it('does not invent a reorg when our own head height is simply missing', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([fillAt(0, '1')]);
    source.appendEmpty(2);

    const warm = new Indexer({
      source,
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    await warm.sync();
    expect((await store.head())?.height).toBe(2);
    expect(await store.recentFills('IFC-USD', 10)).toHaveLength(1);

    const indexer = new Indexer({
      source: gapped(source, 2),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });

    await expect(indexer.sync()).rejects.toBeInstanceOf(MissingBlockError);
    expect(indexer.lastError?.code).toBe('indexer.block_missing');
    expect(indexer.halted).toBeNull();
    // Tape still holds the last canonical fill — a hole is not an unwind.
    expect((await store.head())?.height).toBe(2);
    expect(await store.recentFills('IFC-USD', 10)).toHaveLength(1);
  });

  it('still repairs when the chain shortened below our head', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([fillAt(0, '1')]);
    source.append([fillAt(0, '2')]);
    source.appendEmpty(3);

    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    await indexer.sync();
    expect((await store.head())?.height).toBe(4);
    expect(await store.recentFills('IFC-USD', 10)).toHaveLength(2);

    source.reorg(0, [[]]);
    const result = await indexer.sync();
    expect(result.reorgs).toBeGreaterThan(0);
    expect((await store.head())?.height).toBe(1);
    const tape = await store.recentFills('IFC-USD', 10);
    expect(tape).toHaveLength(1);
    expect(tape[0]?.blockHeight).toBe(0);
  });
});

describe('the projection and the public reads · reorg and halt are not success', () => {
  it('keeps no reorged fill on the tape', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([fillAt(0, '1')]);
    const dead = source.append([fillAt(0, '9')]);

    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    await indexer.sync();
    expect(await store.recentFills('IFC-USD', 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ blockHash: dead.hash, quantity: expect.anything() })]),
    );

    source.reorg(0, [[{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' }]]);
    await indexer.sync();

    const fills = await store.recentFills('IFC-USD', 100);
    expect(fills.find((f) => f.blockHash === dead.hash)).toBeUndefined();
    expect(fills.find((f) => formatAmount(f.quantity) === '9')).toBeUndefined();
    const account = await store.fillsForAccount(MAKER, 100);
    expect(account.find((f) => f.blockHash === dead.hash)).toBeUndefined();
  });

  it('the book and positions are not served after a deep-reorg halt', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' }, fillAt(1, '1')]);
    source.appendEmpty(5);

    const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
    await indexer.sync();
    source.reorg(0, [[], [], []]);
    await expect(indexer.sync()).rejects.toThrow(/deeper than retained history/);

    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 1,
      ingestEnabled: () => true,
      chainSource: 'memory',
      venue: WIRED_VENUE,
      rpcUrl: 'http://127.0.0.1:8545',
    }).createCaller(anonymous());

    await expect(caller.book({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(caller.positions({ account: MAKER, limit: 100 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
