import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource, NullChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { createIndexerRouter } from './router.js';
import { chainSourceRefusesServing, nullChainServingReason } from './serving.js';
import { CHAIN_ID } from './testing/conformance.js';

/**
 * TRK-indexer.readmodels — a holding / read-model we cannot currently read is
 * absent and named, never a silent zero.
 *
 * Halt and chain-door lastError already 503 data paths. `NullChainSource`
 * never sets lastError (idle `no-chain`), so without this door `book` returns
 * empty ladders and `position` returns null — which a portfolio reads as zero.
 */

const EDGE_SECRET = 'a-indexer-absent-not-zero-edge-secret-long';
const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMPTY_ACCOUNT = '0x0000000000000000000000000000000000000001';

function anonymous() {
  return createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-indexer' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-absent',
  });
}

describe('null chainSource refuses serving', () => {
  it('names NullChain as a serving refuse, not a live empty book', () => {
    expect(chainSourceRefusesServing('null')).toBe(true);
    expect(chainSourceRefusesServing('evm')).toBe(false);
    expect(chainSourceRefusesServing('memory')).toBe(false);
    expect(nullChainServingReason()).toBe('indexer.chain_not_configured');
    expect(nullChainServingReason()).not.toMatch(/will not serve|absent, never zero|empty book/i);
  });
});

describe('unread holding is absent and named', () => {
  it('refuses book and positions when no chain is wired — not empty arrays or null', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new NullChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    expect((await indexer.sync()).idle).toBe('no-chain');
    expect(indexer.lastError).toBeNull();
    expect(indexer.halted).toBeNull();

    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'null',
    }).createCaller(anonymous());

    const status = await caller.status();
    expect(status.chainSource).toBe('null');
    expect(status.lastError).toBeNull();

    await expect(caller.book({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringMatching(/indexer\.chain_not_configured/),
    });
    await expect(caller.positions({ account: ACCOUNT, limit: 2 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'indexer.chain_not_configured',
    });
  });

  it('a readable chain still returns no row for an account with no position — that is no holding, not unread', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    source.append([
      {
        kind: 'position',
        logIndex: 0,
        market: 'IFC-USD',
        account: ACCOUNT,
        size: '-1.5',
        entryPrice: '100.5',
      },
    ]);
    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    await indexer.sync();

    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'memory',
    }).createCaller(anonymous());

    await expect(caller.positions({ account: ACCOUNT, limit: 2 })).resolves.toMatchObject([{ market: 'IFC-USD', size: '-1.5' }]);
    await expect(caller.positions({ account: EMPTY_ACCOUNT, limit: 2 })).resolves.toEqual([]);
  });
});
