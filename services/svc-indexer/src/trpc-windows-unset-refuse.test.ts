/**
 * Unit card — tRPC book/positions window unset refuse (no invented 50)
 *
 * 1. Promise: omit depth/limit does not publish a 50-level book or 100 prints
 *    or an unbounded markets/positions dump. Owner/query may pass 50/100/2
 *    explicitly.
 * 2. Break: `.default(50)` / `.default(100)` and `input?.depth ?? 50` made
 *    omit look chosen; `[...store.markets()]` / `positionsOf` dumped the set.
 * 3. Done bar: no `.default(50|100)` / `?? 50` in router; omit BAD_REQUEST
 *    typed; explicit 50/100/2 served; 0 / over-cap refuse; store not called.
 * 4. Class N
 * 5. Paths: router.ts book/positions,
 *    trpc-windows.ts, postgres-store LIMIT
 * 6. RED: omit book returns a 50-level view; omit markets dumps the set
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { PostgresProjectionStore } from './projection/postgres-store.js';
import { createIndexerRouter } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';
import { INDEXER_BOOK_DEPTH_UNSET, INDEXER_POSITIONS_LIST_LIMIT_UNSET, isPublishedBookDepth } from './trpc-windows.js';
import { userCopy } from './user-copy.js';

const SECRET = 'an-indexer-window-test-edge-secret-length';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const WIRED_VENUE = '0x78fbe21605d9424efdd6b2fddc4e846e8c746a4b';
const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function spyStore() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const bookSeen: number[] = [];
  const positionsSeen: number[] = [];
  const origBook = store.book.bind(store);
  const origBookFinalized = store.bookFinalized.bind(store);
  const origPositions = store.positionsOf.bind(store);
  store.book = async (market, depth) => {
    bookSeen.push(depth);
    return origBook(market, depth);
  };
  store.bookFinalized = async (market, depth, finalityDepth) => {
    bookSeen.push(depth);
    return origBookFinalized(market, depth, finalityDepth);
  };
  store.positionsOf = async (account, limit) => {
    positionsSeen.push(limit);
    return origPositions(account, limit);
  };
  return { store, bookSeen, positionsSeen };
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
  it('unset / 0 / over-cap / non-integer refuse — never invent 50', () => {
    expect(isPublishedBookDepth(undefined)).toBe(false);
    expect(isPublishedBookDepth(null)).toBe(false);
    expect(isPublishedBookDepth(0)).toBe(false);
    expect(isPublishedBookDepth(201)).toBe(false);
    expect(isPublishedBookDepth(50.5)).toBe(false);
  });

  it('owner-explicit 50 is a published window', () => {
    expect(isPublishedBookDepth(50)).toBe(true);
    expect(isPublishedBookDepth(1)).toBe(true);
    expect(isPublishedBookDepth(200)).toBe(true);
  });
});

describe('tRPC book refuses unpublished windows', () => {
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

describe('tRPC positions refuses an unset list limit', () => {
  it('postgres-store positionsOf applies SQL LIMIT — no unbounded dump', async () => {
    // The query the store sends, through a recording stand-in for the connection.
    const sent: Array<{ text: string; values: unknown[] }> = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
      sent.push({ text: strings.join('$?'), values });
      return Promise.resolve([]);
    };
    const store = new PostgresProjectionStore(sql as ConstructorParameters<typeof PostgresProjectionStore>[0], CHAIN_ID);
    await expect(store.positionsOf(ACCOUNT, 2)).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
    const query = sent[0]!;
    expect(query.text.replace(/\s+/g, ' ').trim()).toMatch(/LIMIT \$\?$/);
    expect(query.values.at(-1)).toBe(2);
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

  it('published limit 2 slices positions', async () => {
    const { store, positionsSeen } = spyStore();
    const caller = await wiredListCaller(store);
    const positions = await caller.positions({ account: ACCOUNT, limit: 2 });
    expect(positions.map((p) => p.market)).toEqual(['AAA-USD', 'BBB-USD']);
    expect(positionsSeen).toEqual([2]);
  });

  it('empty positions stay empty — not a fabricated row', async () => {
    const caller = emptyWiredCaller();
    expect(await caller.positions({ account: ACCOUNT, limit: 2 })).toEqual([]);
  });
});
