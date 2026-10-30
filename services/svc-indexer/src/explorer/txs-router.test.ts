/**
 * Unit card — indexer.explorer.txs.list and blocks.list finalizedHeight (J-dex-protocol-09 #1, #2)
 *
 * 1. Promise: latest transactions are owner-bounded (unset refuses), newest first, orphans kept with
 *    their reason, value as a decimal wei string; unwired refuses; another network reads empty, never
 *    this network's rows. blocks.list states the finalized height from the head and the finality depth.
 * 2. Break: an invented page size, a float value, a hidden orphan, a finalized height with no head.
 * 3. Done bar: the tests below.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from '../chain/memory-source.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter, type IndexerRouterDeps } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import { INDEXER_EXPLORER_LIST_LIMIT_UNSET, INDEXER_EXPLORER_UNWIRED, memoryExplorerSource, parseExplorerListLimit } from './blocks.js';
import type { ExplorerTxList, ExplorerTxListFact } from './tx.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-explorer-txs-test-edge-secret', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const hex = (n: number, bytes: number) => `0x${n.toString(16).padStart(bytes * 2, '0')}`;

const tx = (height: number, index: number, over: Partial<ExplorerTxListFact> = {}): ExplorerTxListFact => ({
  hash: hex(height * 100 + index, 32),
  blockHeight: height,
  blockHash: hex(height, 32),
  index,
  from: hex(1, 20),
  to: hex(2, 20),
  valueWei: 12_345_678_901_234_567_890n,
  status: 'success',
  timestamp: 1_700_000_000 + height,
  orphaned: null,
  ...over,
});
const TXS = [tx(3, 1), tx(3, 0, { status: 'failed' }), tx(2, 0, { blockHash: hex(0xee, 32), orphaned: { reason: 'reorg' } }), tx(1, 0)];

/** Memory twin of the store query: keyset on (height, index, hash) descending, limit + 1. */
const memoryList =
  (rows: readonly ExplorerTxListFact[]): ExplorerTxList =>
  async ({ cursor, blockHash, limit }) =>
    rows
      .filter((r) => blockHash === undefined || r.blockHash === blockHash)
      .filter(
        (r) =>
          cursor === undefined ||
          r.blockHeight < cursor.height ||
          (r.blockHeight === cursor.height && (r.index < cursor.index || (r.index === cursor.index && r.hash < cursor.hash))),
      )
      .slice(0, limit + 1);

async function caller(over: Partial<IndexerRouterDeps> = {}, heads = 0) {
  const store = new MemoryProjectionStore(CHAIN_ID);
  let parent = hex(0, 32);
  for (let h = 0; h < heads; h++) {
    const hash = hex(0x100 + h, 32);
    await store.applyBlock({ chainId: CHAIN_ID, height: h, hash, parentHash: parent, timestamp: 1_700_000_000 + h, events: [] });
    parent = hash;
  }
  const indexer = new Indexer({
    source: new MemoryChainSource(CHAIN_ID),
    store,
    finalityDepth: 2,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 2,
    ingestEnabled: () => true,
    chainSource: 'memory',
    explorer: memoryExplorerSource(parseExplorerListLimit('2'), []),
    txList: memoryList(TXS),
    ...over,
  }).createCaller(anonymous());
}

describe('indexer.explorer.txs.list', () => {
  it('newest first, owner-bounded, orphan kept, value a decimal string; pages lose nothing', async () => {
    const c = await caller();
    const first = await c.explorer.txs.list({ chainId: CHAIN_ID, limit: 50 });
    expect(first.rows.map((r) => [r.blockHeight, r.index])).toEqual([
      [3, 1],
      [3, 0],
    ]);
    expect(first.rows[0]).toMatchObject({ chainId: CHAIN_ID, value: '12345678901234567890', status: 'success' });
    expect(first.rows[1]?.status).toBe('failed');
    expect(Number.isNaN(Date.parse(first.asOf))).toBe(false);
    const second = await c.explorer.txs.list({ chainId: CHAIN_ID, cursor: first.nextCursor ?? undefined });
    expect(second.rows.map((r) => [r.blockHeight, r.orphaned])).toEqual([
      [2, { reason: 'reorg' }],
      [1, null],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('one block’s transactions', async () => {
    const c = await caller();
    const page = await c.explorer.txs.list({ chainId: CHAIN_ID, blockHash: hex(0xee, 32) });
    expect(page.rows.map((r) => r.hash)).toEqual([hex(200, 32)]);
  });

  it('a blank owner list limit refuses with its code', async () => {
    const c = await caller({ explorer: memoryExplorerSource(parseExplorerListLimit(''), []) });
    await expect(c.explorer.txs.list({ chainId: CHAIN_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    });
  });

  it('unwired refuses, never an empty list', async () => {
    const c = await caller({ txList: undefined });
    await expect(c.explorer.txs.list({ chainId: CHAIN_ID })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy(INDEXER_EXPLORER_UNWIRED),
    });
  });

  it('another network reads empty, not this one', async () => {
    const c = await caller();
    expect((await c.explorer.txs.list({ chainId: CHAIN_ID + 1 })).rows).toEqual([]);
  });
});

describe('indexer.explorer.blocks.list finalizedHeight', () => {
  it('is the head minus the finality depth', async () => {
    const c = await caller({}, 5);
    expect((await c.explorer.blocks.list({ chainId: CHAIN_ID })).finalizedHeight).toBe(2);
  });

  it('is null before the first block and on another network', async () => {
    expect((await (await caller()).explorer.blocks.list({ chainId: CHAIN_ID })).finalizedHeight).toBeNull();
    expect((await (await caller({}, 5)).explorer.blocks.list({ chainId: CHAIN_ID + 1 })).finalizedHeight).toBeNull();
  });
});
