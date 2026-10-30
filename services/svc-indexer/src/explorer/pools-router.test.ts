/**
 * Unit card — indexer.explorer.pools.list, .get and .swaps (D-explorer-05, J-dex-protocol-09 #7)
 *
 * 1. Promise: pools come only from the owner's factory; a blank factory, a blank list limit and an unwired store each
 *    refuse by name; an address the factory did not create is `indexer.not_a_pool`; another network lists none;
 *    swaps say buy or sell from token0's side; candles need both tokens' decimals and are null without them.
 * 2. Break: a decoy factory's pool listed, a guessed price scale, a float amount, a pool on another network.
 * 3. Done bar: the tests below and the Postgres store test "D-explorer-05".
 */
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from '../chain/memory-source.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter, type IndexerRouterDeps } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import { INDEXER_EXPLORER_LIST_LIMIT_UNSET, INDEXER_EXPLORER_UNWIRED, memoryExplorerSource, parseExplorerListLimit } from './blocks.js';
import {
  INDEXER_NOT_A_POOL,
  INDEXER_POOL_FACTORY_UNSET,
  POOL_CREATED_TOPIC,
  POOL_SWAP_TOPIC,
  POOL_SYNC_TOPIC,
  parsePoolFactory,
  poolCreatedOf,
  priceScale,
  swapOf,
  swapSide,
  syncOf,
  type ExplorerPoolReads,
  type PoolFact,
  type PoolSwapFact,
} from './pools.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-explorer-pools-test-edge-secret', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const addr = (byte: string) => `0x${byte.repeat(20)}`;
const FACTORY = addr('f1');
const POOL = addr('90');
const word = (value: bigint | string) =>
  typeof value === 'string' ? `${'00'.repeat(12)}${value.slice(2)}` : value.toString(16).padStart(64, '0');

const pool = (over: Partial<PoolFact> = {}): PoolFact => ({
  pool: POOL,
  factory: FACTORY,
  token0: { address: addr('0c'), symbol: 'TA', name: 'TEST A', decimals: 18 },
  token1: { address: addr('0d'), symbol: 'TB', name: 'TEST B', decimals: 6 },
  feeBps: 30,
  createdHeight: 4,
  createdTx: `0x${'b1'.repeat(32)}`,
  cursor: { height: 4, index: 0, logIndex: 0 },
  reserves: { reserve0: 10n ** 30n, reserve1: 21_000_000n, height: 7 },
  ...over,
});

const swap = (height: number, over: Partial<PoolSwapFact> = {}): PoolSwapFact => ({
  hash: `0x${height.toString(16).padStart(64, '0')}`,
  blockHeight: height,
  index: 0,
  logIndex: 1,
  timestamp: 1_700_000_000 + height,
  sender: addr('ee'),
  recipient: addr('ee'),
  amount0In: 0n,
  amount1In: 2_000_000n,
  amount0Out: 10n ** 18n,
  amount1Out: 0n,
  ...over,
});

function reads(pools: PoolFact[], swaps: PoolSwapFact[] = []): ExplorerPoolReads & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    list: async ({ factory, limit }) => pools.filter((p) => p.factory === factory).slice(0, limit + 1),
    get: async ({ factory, pool: address }) => pools.find((p) => p.factory === factory && p.pool === address) ?? null,
    swaps: async ({ limit }) => swaps.slice(0, limit + 1),
    volume: async () => ({ volume1: 3_000_000n, swaps: swaps.length }),
    candles: async (q) => {
      asked.push(q);
      return [{ start: 1_699_999_200, open: '2', high: '2', low: '1', close: '1', volume1: 3_000_000n, swaps: 2 }];
    },
  };
}

async function caller(over: Partial<IndexerRouterDeps> = {}, limit = '2') {
  const store = new MemoryProjectionStore(CHAIN_ID);
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
    explorer: memoryExplorerSource(parseExplorerListLimit(limit), []),
    pools: {
      reads: reads(
        [pool(), pool({ pool: addr('91'), factory: addr('f2') })],
        [swap(9), swap(8, { amount0In: 10n ** 18n, amount1In: 0n, amount0Out: 0n, amount1Out: 1_000_000n }), swap(7)],
      ),
      factory: FACTORY,
    },
    ...over,
  }).createCaller(anonymous());
}

describe('D-explorer-05 pool logs', () => {
  it('pins each topic to its event signature', () => {
    expect(POOL_CREATED_TOPIC).toBe(keccak256(toBytes('PoolCreated(address,address,uint16,address,uint256)')));
    expect(POOL_SWAP_TOPIC).toBe(keccak256(toBytes('Swap(address,uint256,uint256,uint256,uint256,address)')));
    expect(POOL_SYNC_TOPIC).toBe(keccak256(toBytes('Sync(uint112,uint112)')));
  });

  it('decodes PoolCreated, Swap and Sync, and refuses any other shape', () => {
    const created = {
      logIndex: 3,
      address: FACTORY.toUpperCase().replace('0X', '0x'),
      topics: [POOL_CREATED_TOPIC, `0x${word(addr('0c'))}`, `0x${word(addr('0d'))}`],
      data: `0x${word(30n)}${word(POOL)}${word(0n)}`,
    };
    expect(poolCreatedOf(created)).toEqual({
      logIndex: 3,
      factory: FACTORY,
      pool: POOL,
      token0: addr('0c'),
      token1: addr('0d'),
      feeBps: 30,
    });
    expect(poolCreatedOf({ ...created, data: `0x${word(70_000n)}${word(POOL)}${word(0n)}` })).toBeNull();
    expect(poolCreatedOf({ ...created, data: '0x' })).toBeNull();
    expect(poolCreatedOf({ ...created, topics: created.topics.slice(0, 2) })).toBeNull();

    const swapLog = {
      logIndex: 1,
      address: POOL,
      topics: [POOL_SWAP_TOPIC, `0x${word(addr('ee'))}`, `0x${word(addr('ef'))}`],
      data: `0x${word(1n)}${word(2n ** 200n)}${word(0n)}${word(4n)}`,
    };
    expect(swapOf(swapLog)).toEqual({
      logIndex: 1,
      pool: POOL,
      sender: addr('ee'),
      recipient: addr('ef'),
      amount0In: 1n,
      amount1In: 2n ** 200n,
      amount0Out: 0n,
      amount1Out: 4n,
    });
    expect(swapOf({ ...swapLog, data: `0x${word(1n)}` })).toBeNull();
    expect(swapOf({ ...swapLog, topics: [POOL_SYNC_TOPIC] })).toBeNull();

    expect(syncOf({ logIndex: 0, address: POOL, topics: [POOL_SYNC_TOPIC], data: `0x${word(5n)}${word(6n)}` })).toEqual({
      logIndex: 0,
      pool: POOL,
      reserve0: 5n,
      reserve1: 6n,
    });
    expect(syncOf({ logIndex: 0, address: POOL, topics: [POOL_SYNC_TOPIC, `0x${word(5n)}`], data: `0x${word(5n)}${word(6n)}` })).toBeNull();
  });

  it('labels a swap from token0’s side and never picks one for a swap that moved token0 both ways', () => {
    expect(swapSide({ amount0In: 0n, amount0Out: 5n })).toBe('buy');
    expect(swapSide({ amount0In: 5n, amount0Out: 0n })).toBe('sell');
    expect(swapSide({ amount0In: 5n, amount0Out: 5n })).toBe('both');
    expect(swapSide({ amount0In: 0n, amount0Out: 0n })).toBe('both');
  });

  it('scales a raw ratio by the decimals both tokens stated, and has no scale when one is unknown', () => {
    expect(priceScale(18, 6)).toBe('1000000000000');
    expect(priceScale(6, 18)).toBe('0.000000000001');
    expect(priceScale(8, 8)).toBe('1');
    expect(priceScale(null, 6)).toBeNull();
  });

  it('reads the factory setting: blank is none, a non-address refuses to start', () => {
    expect(parsePoolFactory(undefined)).toBeNull();
    expect(parsePoolFactory('  ')).toBeNull();
    expect(parsePoolFactory(FACTORY.toUpperCase().replace('0X', '0x'))).toBe(FACTORY);
    expect(() => parsePoolFactory('0x1234')).toThrow(/INDEXER_POOL_FACTORY_ADDRESS/);
  });
});

describe('D-explorer-05 indexer.explorer.pools', () => {
  it('lists only the owner factory’s pools, with raw reserves as decimal strings, owner-paged', async () => {
    const out = await (await caller()).explorer.pools.list({ chainId: CHAIN_ID });
    expect(out.rows).toEqual([
      {
        chainId: CHAIN_ID,
        address: POOL,
        factory: FACTORY,
        token0: { address: addr('0c'), symbol: 'TA', name: 'TEST A', decimals: 18 },
        token1: { address: addr('0d'), symbol: 'TB', name: 'TEST B', decimals: 6 },
        feeBps: 30,
        createdHeight: 4,
        createdTx: `0x${'b1'.repeat(32)}`,
        reserves: { reserve0: (10n ** 30n).toString(), reserve1: '21000000', height: 7 },
      },
    ]);
    expect(out.nextCursor).toBeNull();
    expect((await (await caller()).explorer.pools.list({ chainId: CHAIN_ID + 1 })).rows).toEqual([]);
  });

  it('refuses by name: blank factory, blank list limit, unwired', async () => {
    await expect(
      (await caller({ pools: { reads: reads([]), factory: null } })).explorer.pools.list({ chainId: CHAIN_ID }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy(INDEXER_POOL_FACTORY_UNSET),
    });
    await expect((await caller({}, '')).explorer.pools.list({ chainId: CHAIN_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    });
    await expect((await caller({ pools: undefined })).explorer.pools.get({ chainId: CHAIN_ID, address: POOL })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy(INDEXER_EXPLORER_UNWIRED),
    });
  });

  it('an address the factory did not create is not a pool: another factory’s, a token, another network', async () => {
    for (const q of [
      { chainId: CHAIN_ID, address: addr('91') },
      { chainId: CHAIN_ID, address: addr('0c') },
      { chainId: CHAIN_ID + 1, address: POOL },
    ]) {
      await expect((await caller()).explorer.pools.get(q)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: userCopy(INDEXER_NOT_A_POOL),
      });
      await expect((await caller()).explorer.pools.swaps(q)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: userCopy(INDEXER_NOT_A_POOL),
      });
    }
  });

  it('a pool reads its day: volume, swaps and candles at the asked width, scaled by both tokens’ decimals', async () => {
    const r = reads([pool()]);
    const out = await (
      await caller({ pools: { reads: r, factory: FACTORY } })
    ).explorer.pools.get({ chainId: CHAIN_ID, address: POOL.toUpperCase().replace('0X', '0x'), interval: '5m' });
    expect(out.volume1).toBe('3000000');
    expect(out.window.seconds).toBe(86_400);
    expect(out.candles).toEqual([{ start: 1_699_999_200, open: '2', high: '2', low: '1', close: '1', volume1: '3000000', swaps: 2 }]);
    expect(r.asked).toEqual([expect.objectContaining({ pool: POOL, seconds: 300, scale: '1000000000000' })]);
  });

  it('a token that never said its decimals leaves the candles unread, never a guessed scale', async () => {
    const r = reads([pool({ token1: { address: addr('0d'), symbol: null, name: null, decimals: null } })]);
    const out = await (await caller({ pools: { reads: r, factory: FACTORY } })).explorer.pools.get({ chainId: CHAIN_ID, address: POOL });
    expect(out.candles).toBeNull();
    expect(r.asked).toEqual([]);
  });

  it('an out-of-range cursor is a typed BAD_REQUEST, never a database cast error', async () => {
    await expect(
      (await caller()).explorer.pools.swaps({ chainId: CHAIN_ID, address: POOL, cursor: { height: 2 ** 60, index: 0, logIndex: 0 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      (await caller()).explorer.pools.list({ chainId: CHAIN_ID, cursor: { height: 1, index: 2 ** 31, logIndex: 0 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('swaps read newest first, labelled buy or sell, owner-paged with a cursor', async () => {
    const out = await (await caller()).explorer.pools.swaps({ chainId: CHAIN_ID, address: POOL });
    expect(out.rows.map((row) => [row.blockHeight, row.side])).toEqual([
      [9, 'buy'],
      [8, 'sell'],
    ]);
    expect(out.rows[0]).toMatchObject({ amount1In: '2000000', amount0Out: '1000000000000000000' });
    expect(out.nextCursor).toEqual({ height: 8, index: 0, logIndex: 1 });
  });
});
