/**
 * Unit card — tRPC book/fills/stream/list window unset refuse (no invented 50/100)
 *
 * 1. Promise: omit depth/limit does not publish a 50-level book or 100 prints
 *    or an unbounded markets/positions dump. Owner/query may pass 50/100/2
 *    explicitly.
 * 2. Break: `.default(50)` / `.default(100)` and `input?.depth ?? 50` made
 *    omit look chosen; `[...store.markets()]` / `positionsOf` dumped the set.
 * 3. Done bar: no `.default(50|100)` / `?? 50` in router; omit BAD_REQUEST
 *    typed; explicit 50/100/2 served; 0 / over-cap refuse; store not called.
 * 4. Class N
 * 5. Paths: router.ts book/fills/accountFills/markets/positions/stream,
 *    trpc-windows.ts, postgres-store LIMIT
 * 6. RED: omit book returns a 50-level view; omit markets dumps the set
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { createIndexerRouter } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';
import {
  INDEXER_BOOK_DEPTH_UNSET,
  INDEXER_FILLS_LIMIT_UNSET,
  INDEXER_MARKETS_LIST_LIMIT_UNSET,
  INDEXER_POSITIONS_LIST_LIMIT_UNSET,
  INDEXER_STREAM_DEPTH_UNSET,
  INDEXER_STREAM_MARKETS_LIMIT_UNSET,
  isPublishedBookDepth,
  isPublishedFillsLimit,
} from './trpc-windows.js';
import { userCopy } from './user-copy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'an-indexer-window-test-edge-secret-length';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const WIRED_VENUE = '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b';
const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function spyStore() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const bookSeen: number[] = [];
  const fillsSeen: number[] = [];
  const accountSeen: number[] = [];
  const marketsSeen: number[] = [];
  const positionsSeen: number[] = [];
  const origBook = store.book.bind(store);
  const origBookFinalized = store.bookFinalized.bind(store);
  const origFills = store.recentFills.bind(store);
  const origAccount = store.fillsForAccount.bind(store);
  const origMarkets = store.markets.bind(store);
  const origPositions = store.positionsOf.bind(store);
  store.book = async (market, depth) => {
    bookSeen.push(depth);
    return origBook(market, depth);
  };
  store.bookFinalized = async (market, depth, finalityDepth) => {
    bookSeen.push(depth);
    return origBookFinalized(market, depth, finalityDepth);
  };
  store.recentFills = async (market, limit) => {
    fillsSeen.push(limit);
    return origFills(market, limit);
  };
  store.fillsForAccount = async (account, limit) => {
    accountSeen.push(limit);
    return origAccount(account, limit);
  };
  store.markets = async (limit) => {
    marketsSeen.push(limit);
    return origMarkets(limit);
  };
  store.positionsOf = async (account, limit) => {
    positionsSeen.push(limit);
    return origPositions(account, limit);
  };
  return { store, bookSeen, fillsSeen, accountSeen, marketsSeen, positionsSeen };
}

async function wiredCaller(store: MemoryProjectionStore) {
  const source = new MemoryChainSource(CHAIN_ID);
  source.append([
    { kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' },
    {
      kind: 'fill',
      logIndex: 1,
      market: 'IFC-USD',
      price: '100.5',
      quantity: '1',
      takerSide: 'buy',
      maker: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      taker: '0xBBbBbBBbbBbBbbBbbbbbBBbBbbbbBbBbBbbBBbB0',
    },
  ]);
  const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
  await indexer.sync();
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    venue: WIRED_VENUE,
    rpcUrl: 'http://127.0.0.1:8545',
  }).createCaller(anonymous());
}

describe('tRPC window parse', () => {
  it('unset / 0 / over-cap / non-integer refuse — never invent 50/100', () => {
    expect(isPublishedBookDepth(undefined)).toBe(false);
    expect(isPublishedBookDepth(null)).toBe(false);
    expect(isPublishedBookDepth(0)).toBe(false);
    expect(isPublishedBookDepth(201)).toBe(false);
    expect(isPublishedBookDepth(50.5)).toBe(false);
    expect(isPublishedFillsLimit(undefined)).toBe(false);
    expect(isPublishedFillsLimit(0)).toBe(false);
    expect(isPublishedFillsLimit(501)).toBe(false);
    expect(isPublishedFillsLimit(100.5)).toBe(false);
  });

  it('owner-explicit 50 / 100 are published windows', () => {
    expect(isPublishedBookDepth(50)).toBe(true);
    expect(isPublishedBookDepth(1)).toBe(true);
    expect(isPublishedBookDepth(200)).toBe(true);
    expect(isPublishedFillsLimit(100)).toBe(true);
    expect(isPublishedFillsLimit(1)).toBe(true);
    expect(isPublishedFillsLimit(500)).toBe(true);
  });
});

describe('tRPC book/fills/stream refuse unpublished windows', () => {
  it('router.ts does not invent 50/100', () => {
    const src = readFileSync(join(HERE, 'router.ts'), 'utf8');
    expect(src).not.toMatch(/\.default\(50\)/);
    expect(src).not.toMatch(/\.default\(100\)/);
    expect(src).not.toMatch(/depth \?\? 50/);
    expect(src).not.toMatch(/limit \?\? 100/);
    expect(src).toMatch(/INDEXER_BOOK_DEPTH_UNSET/);
    expect(src).toMatch(/INDEXER_FILLS_LIMIT_UNSET/);
    expect(src).toMatch(/INDEXER_STREAM_DEPTH_UNSET/);
    expect(src).toMatch(/INDEXER_MARKETS_LIST_LIMIT_UNSET/);
    expect(src).toMatch(/INDEXER_POSITIONS_LIST_LIMIT_UNSET/);
    expect(src).toMatch(/INDEXER_STREAM_MARKETS_LIMIT_UNSET/);
  });

  it('omit book depth refuses and does not call store.book', async () => {
    const { store, bookSeen } = spyStore();
    const caller = await wiredCaller(store);
    await expect(caller.book({ market: 'IFC-USD' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_BOOK_DEPTH_UNSET),
    });
    for (const depth of [0, 201, 50.5]) {
      await expect(caller.book({ market: 'IFC-USD', depth })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: userCopy(INDEXER_BOOK_DEPTH_UNSET),
      });
    }
    expect(bookSeen).toEqual([]);
  });

  it('owner-explicit book depth 50 is published (not invented)', async () => {
    const { store, bookSeen } = spyStore();
    const caller = await wiredCaller(store);
    const view = await caller.book({ market: 'IFC-USD', depth: 50 });
    expect(view.bids).toEqual([['100', '5']]);
    expect(bookSeen).toEqual([50]);
  });

  it('omit fills/accountFills limit refuses and does not call the store', async () => {
    const { store, fillsSeen, accountSeen } = spyStore();
    const caller = await wiredCaller(store);
    await expect(caller.fills({ market: 'IFC-USD' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_FILLS_LIMIT_UNSET),
    });
    await expect(caller.accountFills({ account: ACCOUNT })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_FILLS_LIMIT_UNSET),
    });
    for (const limit of [0, 501, 100.5]) {
      await expect(caller.fills({ market: 'IFC-USD', limit })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: userCopy(INDEXER_FILLS_LIMIT_UNSET),
      });
    }
    expect(fillsSeen).toEqual([]);
    expect(accountSeen).toEqual([]);
  });

  it('owner-explicit fills limit 100 is published (not invented)', async () => {
    const { store, fillsSeen, accountSeen } = spyStore();
    const caller = await wiredCaller(store);
    const fills = await caller.fills({ market: 'IFC-USD', limit: 100 });
    const account = await caller.accountFills({ account: ACCOUNT, limit: 100 });
    expect(fills).toHaveLength(1);
    expect(account).toHaveLength(1);
    expect(fillsSeen).toEqual([100]);
    expect(accountSeen).toEqual([100]);
  });

  it('omit stream depth refuses before unwired (does not invent 50)', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const source = new MemoryChainSource(CHAIN_ID);
    const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
    const caller = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'memory',
    }).createCaller(anonymous());
    await expect(caller.stream()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_DEPTH_UNSET),
    });
    await expect(caller.stream({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_DEPTH_UNSET),
    });
    await expect(caller.stream({ market: 'IFC-USD' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_DEPTH_UNSET),
    });
  });

  it('owner-explicit stream depth 50 is published when wired', async () => {
    const { store, bookSeen } = spyStore();
    const caller = await wiredCaller(store);
    const out = await caller.stream({ market: 'IFC-USD', depth: 50 });
    expect(out.status).toBe('ok');
    expect(bookSeen).toEqual([50]);
  });
});

async function wiredListCaller(store: MemoryProjectionStore) {
  const source = new MemoryChainSource(CHAIN_ID);
  source.append([
    { kind: 'book_level', logIndex: 0, market: 'AAA-USD', side: 'bid', price: '1', quantity: '1' },
    { kind: 'book_level', logIndex: 1, market: 'BBB-USD', side: 'bid', price: '1', quantity: '1' },
    { kind: 'book_level', logIndex: 2, market: 'CCC-USD', side: 'bid', price: '1', quantity: '1' },
    { kind: 'position', logIndex: 3, market: 'AAA-USD', account: ACCOUNT, size: '1', entryPrice: '10' },
    { kind: 'position', logIndex: 4, market: 'BBB-USD', account: ACCOUNT, size: '2', entryPrice: '20' },
    { kind: 'position', logIndex: 5, market: 'CCC-USD', account: ACCOUNT, size: '3', entryPrice: '30' },
  ]);
  const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
  await indexer.sync();
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    venue: WIRED_VENUE,
    rpcUrl: 'http://127.0.0.1:8545',
  }).createCaller(anonymous());
}

function emptyWiredCaller() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const source = new MemoryChainSource(CHAIN_ID);
  const indexer = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => true, startHeight: 0 });
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    venue: WIRED_VENUE,
    rpcUrl: 'http://127.0.0.1:8545',
  }).createCaller(anonymous());
}

describe('tRPC markets/positions/stream-all-markets refuse unset list limit', () => {
  it('postgres-store markets/positionsOf apply SQL LIMIT — no unbounded dump', () => {
    const src = readFileSync(join(HERE, 'projection/postgres-store.ts'), 'utf8');
    expect(src).toMatch(/async positionsOf\(account: string, limit: number\)[\s\S]*LIMIT \$\{limit\}/);
    expect(src).toMatch(/async markets\(limit: number\)[\s\S]*LIMIT \$\{limit\}/);
  });

  it('omit markets limit refuses named code and does not call store.markets', async () => {
    const { store, marketsSeen } = spyStore();
    const caller = await wiredCaller(store);
    await expect(caller.markets()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_MARKETS_LIST_LIMIT_UNSET),
    });
    await expect(caller.markets({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_MARKETS_LIST_LIMIT_UNSET),
    });
    for (const limit of [0, 201, 50.5]) {
      await expect(caller.markets({ limit })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: userCopy(INDEXER_MARKETS_LIST_LIMIT_UNSET),
      });
    }
    expect(marketsSeen).toEqual([]);
  });

  it('omit positions limit refuses named code and does not call store.positionsOf', async () => {
    const { store, positionsSeen } = spyStore();
    const caller = await wiredCaller(store);
    await expect(caller.positions({ account: ACCOUNT })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_POSITIONS_LIST_LIMIT_UNSET),
    });
    for (const limit of [0, 201, 50.5]) {
      await expect(caller.positions({ account: ACCOUNT, limit })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: userCopy(INDEXER_POSITIONS_LIST_LIMIT_UNSET),
      });
    }
    expect(positionsSeen).toEqual([]);
  });

  it('omit stream market without marketsLimit refuses — does not invent all-markets', async () => {
    const { store, marketsSeen, bookSeen } = spyStore();
    const caller = await wiredCaller(store);
    await expect(caller.stream({ depth: 50 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_MARKETS_LIMIT_UNSET),
    });
    await expect(caller.stream({ depth: 50, marketsLimit: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_MARKETS_LIMIT_UNSET),
    });
    await expect(caller.stream({ depth: 50, marketsLimit: 201 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_STREAM_MARKETS_LIMIT_UNSET),
    });
    expect(marketsSeen).toEqual([]);
    expect(bookSeen).toEqual([]);
  });

  it('published limit 2 slices markets and positions', async () => {
    const { store, marketsSeen, positionsSeen } = spyStore();
    const caller = await wiredListCaller(store);
    expect(await caller.markets({ limit: 2 })).toEqual(['AAA-USD', 'BBB-USD']);
    const positions = await caller.positions({ account: ACCOUNT, limit: 2 });
    expect(positions.map((p) => p.market)).toEqual(['AAA-USD', 'BBB-USD']);
    expect(marketsSeen).toEqual([2]);
    expect(positionsSeen).toEqual([2]);
  });

  it('empty markets and empty positions stay empty — not a fabricated row', async () => {
    const caller = emptyWiredCaller();
    expect(await caller.markets({ limit: 2 })).toEqual([]);
    expect(await caller.positions({ account: ACCOUNT, limit: 2 })).toEqual([]);
  });

  it('stream empty projection stays empty deltas — never a live $0 book', async () => {
    const caller = emptyWiredCaller();
    const omittedMarket = await caller.stream({ depth: 50, marketsLimit: 2 });
    expect(omittedMarket).toEqual({
      status: 'ok',
      code: null,
      deltas: [],
      clob: { live: true, kind: 'sovereign-venue', reserves: false },
    });
    const named = await caller.stream({ market: 'IFC-USD', depth: 50 });
    expect(named.deltas).toEqual([]);
    expect(named.status).toBe('ok');
  });

  it('published stream marketsLimit 2 slices books and does not invent 50', async () => {
    const { store, marketsSeen, bookSeen } = spyStore();
    const caller = await wiredListCaller(store);
    const out = await caller.stream({ depth: 50, marketsLimit: 2 });
    expect(out.status).toBe('ok');
    expect(out.deltas).toHaveLength(2);
    expect(out.deltas.map((d) => d.marketId)).toEqual(['AAA-USD', 'BBB-USD']);
    expect(marketsSeen).toEqual([2]);
    expect(bookSeen).toEqual([50, 50]);
  });
});
