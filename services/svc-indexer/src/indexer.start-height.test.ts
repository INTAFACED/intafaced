import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from './chain/memory-source.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { Indexer, StartHeightAboveTipError, StartHeightUnavailableError } from './indexer.js';
import { readinessOf } from './ready.js';
import { createIndexerRouter } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';

const EDGE_SECRET = 'a-indexer-start-height-edge-secret-long-enough';

function anonymous() {
  return createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-indexer' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-start-height',
  });
}

/**
 * Cold start must honour INDEXER_START_HEIGHT / deps.startHeight.
 * On L2s the first relevant block is not 0; starting at 0 against a chain that
 * only has history above N is a permanent empty projection that looks healthy.
 */
describe('Indexer · startHeight cold start', () => {
  it('begins projection at startHeight, not at genesis zero', async () => {
    const source = new MemoryChainSource(CHAIN_ID, 0);
    source.appendEmpty(10); // heights 0..9
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 64,
      batchSize: 1,
      ingestEnabled: () => true,
      startHeight: 5,
    });

    // First pass applies exactly the start block.
    const first = await indexer.sync();
    expect(first.blocksApplied).toBe(1);
    expect((await store.head())?.height).toBe(5);
    // Heights below the start were never projected (no head at 0..4).
    expect(await store.blockAt(0)).toBeNull();
    expect(await store.blockAt(4)).toBeNull();
    expect(await store.blockAt(5)).not.toBeNull();
  });

  it('catches up from a non-zero chain startHeight on MemoryChainSource', async () => {
    const START = 100;
    const source = new MemoryChainSource(CHAIN_ID, START);
    source.appendEmpty(4); // 100..103
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 64,
      batchSize: 50,
      ingestEnabled: () => true,
      startHeight: START,
    });

    const result = await indexer.sync();
    expect(result.blocksApplied).toBe(4);
    expect((await store.head())?.height).toBe(103);
  });
});

it('batchSize 1 applies one block per pass and reports not caught up until tip', async () => {
  const source = new MemoryChainSource(CHAIN_ID, 0);
  source.appendEmpty(3); // 0..2
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source,
    store,
    finalityDepth: 64,
    batchSize: 1,
    ingestEnabled: () => true,
    startHeight: 0,
  });

  const a = await indexer.sync();
  expect(a.blocksApplied).toBe(1);
  expect(a.caughtUp).toBe(false);
  expect((await store.head())?.height).toBe(0);

  const b = await indexer.sync();
  expect(b.blocksApplied).toBe(1);
  expect((await store.head())?.height).toBe(1);

  await indexer.sync(); // height 2
  const done = await indexer.sync();
  expect(done.blocksApplied).toBe(0);
  expect(done.caughtUp).toBe(true);
  expect((await store.head())?.height).toBe(2);
});

it('startHeight above chain tip refuses — no healthy empty caughtUp', async () => {
  const source = new MemoryChainSource(CHAIN_ID, 0);
  source.appendEmpty(3); // tip height 2
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source,
    store,
    finalityDepth: 64,
    batchSize: 10,
    ingestEnabled: () => true,
    startHeight: 50,
  });

  await expect(indexer.sync()).rejects.toBeInstanceOf(StartHeightAboveTipError);
  expect(await store.head()).toBeNull();
  expect(indexer.lastError?.code).toBe('indexer.start_height_above_tip');
  // Must not look like a successful empty catch-up.
  expect(indexer.halted).toBeNull();
});

/**
 * Dual of above-tip: tip is ahead of startHeight, but the start block itself is
 * missing (source begins at 100; indexer still asks for 0). Before this refuse,
 * the pass returned caughtUp with an empty store — healthy-looking lie.
 */
it('startHeight missing under a live tip refuses — no healthy empty caughtUp', async () => {
  const source = new MemoryChainSource(CHAIN_ID, 100);
  source.appendEmpty(3); // tip 102; heights 0..99 do not exist
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source,
    store,
    finalityDepth: 64,
    batchSize: 10,
    ingestEnabled: () => true,
    startHeight: 0,
  });

  await expect(indexer.sync()).rejects.toBeInstanceOf(StartHeightUnavailableError);
  expect(await store.head()).toBeNull();
  expect(indexer.lastError?.code).toBe('indexer.start_height_unavailable');
  expect(indexer.halted).toBeNull();
});

it('startHeight lastError refuses book/positions and leaves /ready — empty is not a live book', async () => {
  const source = new MemoryChainSource(CHAIN_ID, 0);
  source.appendEmpty(3);
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({
    source,
    store,
    finalityDepth: 64,
    ingestEnabled: () => true,
    startHeight: 50,
  });
  await expect(indexer.sync()).rejects.toBeInstanceOf(StartHeightAboveTipError);

  const caller = createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
  }).createCaller(anonymous());

  await expect(caller.status()).resolves.toMatchObject({
    lastError: expect.objectContaining({ code: 'indexer.start_height_above_tip' }),
    halted: null,
    indexedHeight: null,
  });
  await expect(caller.book({ market: 'IFC-USD', depth: 50 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  await expect(caller.positions({ account: '0x' + 'a'.repeat(40), limit: 2 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  const ready = readinessOf(indexer.halted, true, undefined, indexer.lastError);
  expect(ready.httpStatus).toBe(503);
  expect(ready.body.ready).toBe(false);
});
