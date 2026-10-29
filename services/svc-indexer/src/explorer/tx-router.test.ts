/**
 * Unit card — indexer.explorer.tx.get (D-explorer-02)
 *
 * 1. Promise: unknown hash is protocol.not_found; unwired is
 *    indexer.explorer_unwired; a node failure is not "not found"; a blank
 *    drop window is indexer.tx_drop_window_unset.
 * 2. Break: a transport error rendered as not_found, or a dropped body of zeros.
 * 3. Done bar: the tests below.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { ChainUnavailableError } from '../chain/evm/availability.js';
import { MemoryChainSource } from '../chain/memory-source.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import { INDEXER_EXPLORER_UNWIRED, PROTOCOL_NOT_FOUND } from './blocks.js';
import { INDEXER_TX_DROP_WINDOW_UNSET, parseTxDropWindow, type ExplorerTxSource, type LiveTx } from './tx.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-explorer-tx-test-edge-secret', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const HASH = `0x${'ab'.repeat(32)}`;

function caller(txs: ExplorerTxSource | undefined, halt = false) {
  const indexer = new Indexer({
    source: new MemoryChainSource(CHAIN_ID),
    store: new MemoryProjectionStore(CHAIN_ID),
    finalityDepth: 64,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  if (halt) Object.defineProperty(indexer, 'halted', { get: () => ({ reason: 'test halt', at: new Date(0) }) });
  return createIndexerRouter({
    store: new MemoryProjectionStore(CHAIN_ID),
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    txs,
  }).createCaller(anonymous());
}

function door(over: Partial<ExplorerTxSource> = {}): ExplorerTxSource {
  return {
    dropWindow: parseTxDropWindow('60'),
    indexed: async () => null,
    pendingSince: async () => null,
    notePending: async () => undefined,
    lookup: async () => null,
    ...over,
  };
}

describe('indexer.explorer.tx.get', () => {
  it('unwired refuses, never an empty transaction', async () => {
    await expect(caller(undefined).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy(INDEXER_EXPLORER_UNWIRED),
    });
  });

  it('a halted indexer refuses before a lookup', async () => {
    let looked = false;
    await expect(
      caller(
        door({
          lookup: async () => {
            looked = true;
            return null;
          },
        }),
        true,
      ).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(looked).toBe(false);
  });

  it('a hash the node has never had is not found', async () => {
    await expect(caller(door()).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: userCopy(PROTOCOL_NOT_FOUND),
    });
  });

  it('another chain id is not found and does not ask the node', async () => {
    let looked = false;
    await expect(
      caller(
        door({
          lookup: async () => {
            looked = true;
            return null;
          },
        }),
      ).explorer.tx.get({ chainId: CHAIN_ID + 1, hash: HASH }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: userCopy(PROTOCOL_NOT_FOUND) });
    expect(looked).toBe(false);
  });

  it('a node failure is unavailable, not not-found', async () => {
    await expect(
      caller(
        door({
          lookup: async () => {
            throw new ChainUnavailableError('indexer.chain_unreachable', 'down');
          },
        }),
      ).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy('indexer.chain_unreachable'),
    });
  });

  it('a blank drop window refuses a hash we already saw', async () => {
    await expect(
      caller(
        door({
          dropWindow: parseTxDropWindow(undefined),
          pendingSince: async () => new Date(Date.now() - 10_000),
        }),
      ).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy(INDEXER_TX_DROP_WINDOW_UNSET),
    });
  });

  it('a mempool hit records one sight and returns no receipt', async () => {
    const noted: string[] = [];
    const live: LiveTx = {
      kind: 'pending',
      from: `0x${'11'.repeat(20)}`,
      to: null,
      valueWei: 0n,
      nonce: 1,
      gasLimit: 21_000n,
      gasPriceWei: null,
      input: '0x',
    };
    const answer = await caller(
      door({
        lookup: async () => live,
        notePending: async (hash) => {
          noted.push(hash);
        },
      }),
    ).explorer.tx.get({ chainId: CHAIN_ID, hash: HASH });
    expect(answer.status).toBe('pending');
    expect(answer.receipt).toBeNull();
    expect(answer.transaction).toMatchObject({ value: '0', gasPrice: null, index: null });
    expect(noted).toEqual([HASH]);
  });
});

describe('indexer.explorer.tx.networks', () => {
  function withNetworks(searchNetworks?: Parameters<typeof createIndexerRouter>[0]['searchNetworks']) {
    const indexer = new Indexer({
      source: new MemoryChainSource(CHAIN_ID),
      store: new MemoryProjectionStore(CHAIN_ID),
      finalityDepth: 64,
      ingestEnabled: () => true,
      startHeight: 0,
    });
    return createIndexerRouter({
      store: new MemoryProjectionStore(CHAIN_ID),
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'memory',
      ...(searchNetworks ? { searchNetworks } : {}),
    }).createCaller(anonymous());
  }

  it('no listed network is an empty list, never an invented one', async () => {
    expect(await withNetworks().explorer.tx.networks({ hash: HASH })).toEqual({ networks: [] });
    expect(await withNetworks([]).explorer.tx.networks({ hash: HASH })).toEqual({ networks: [] });
  });

  it('answers for every listed network in order, each with its own answer, asked with the hash given', async () => {
    const asked: string[] = [];
    const result = await withNetworks([
      {
        chainId: 31337,
        find: async (hash) => {
          asked.push(hash);
          return { chainId: 31337, state: 'found', pending: false, blockHeight: 4, status: 'success' };
        },
      },
      { chainId: 5, find: async () => ({ chainId: 5, state: 'not_checked', code: 'indexer.chain_unreachable' }) },
      { chainId: 6, find: async () => ({ chainId: 6, state: 'not_found' }) },
    ]).explorer.tx.networks({ hash: HASH });
    expect(asked).toEqual([HASH]);
    expect(result.networks).toEqual([
      { chainId: 31337, state: 'found', pending: false, blockHeight: 4, status: 'success' },
      { chainId: 5, state: 'not_checked', code: 'indexer.chain_unreachable' },
      { chainId: 6, state: 'not_found' },
    ]);
  });

  it('refuses a hash that is not one before asking any node', async () => {
    let asked = false;
    const router = withNetworks([
      {
        chainId: 31337,
        find: async () => {
          asked = true;
          return { chainId: 31337, state: 'not_found' };
        },
      },
    ]);
    await expect(router.explorer.tx.networks({ hash: '0x12' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(asked).toBe(false);
  });
});
