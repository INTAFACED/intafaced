import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { MemoryProjectionStore } from './memory-store.js';
import type { ChainBlock } from '../chain/source.js';

const CHAIN = 31337;
const MARKET = 'IFC-USD';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GENESIS = '0x' + '00'.repeat(32);
const H0 = '0x' + '11'.repeat(32);
const H1 = '0x' + '22'.repeat(32);
const H2 = '0x' + '33'.repeat(32);
const OTHER = '0x' + '44'.repeat(32);

/**
 * Height 0 carries the book, the fill, and the position. A later apply of
 * the same hash at head+1 must not move that canonical row.
 */
function storedAtZero(): ChainBlock {
  return {
    chainId: CHAIN,
    height: 0,
    hash: H0,
    parentHash: GENESIS,
    timestamp: 1_700_000_000,
    events: [
      { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: '100', quantity: '5' },
      {
        kind: 'fill',
        logIndex: 1,
        market: MARKET,
        price: '100',
        quantity: '1',
        takerSide: 'buy',
        maker: ALICE,
        taker: BOB,
      },
      { kind: 'position', logIndex: 2, market: MARKET, account: ALICE, size: '2', entryPrice: '100' },
    ],
  };
}

describe('MemoryProjectionStore · a stored block hash stays at its height', () => {
  it('refuses to move a stored hash to head+1 and leaves the old chain link in place', async () => {
    const store = new MemoryProjectionStore(CHAIN);
    const original = storedAtZero();
    await store.applyBlock(original);
    await store.applyBlock({
      chainId: CHAIN,
      height: 1,
      hash: H1,
      parentHash: H0,
      timestamp: 1_700_000_001,
      events: [],
    });

    // Same hash, next height, parent = current head. The price is omitted.
    // A new fill log index would append if the apply were accepted.
    await expect(
      store.applyBlock({
        chainId: CHAIN,
        height: 2,
        hash: H0,
        parentHash: H1,
        timestamp: 1_700_000_002,
        events: [
          {
            kind: 'fill',
            logIndex: 3,
            market: MARKET,
            price: '100',
            quantity: '1',
            takerSide: 'buy',
            maker: ALICE,
            taker: BOB,
          },
        ],
      }),
    ).rejects.toThrow(/block_hash_relocated/);

    const head = await store.head();
    expect(head?.height).toBe(1);
    expect(head?.hash).toBe(H1);
    expect(head?.parentHash).toBe(H0);

    const atZero = await store.blockAt(0);
    expect(atZero?.hash).toBe(H0);
    expect(atZero?.height).toBe(0);
    expect(atZero?.parentHash).toBe(GENESIS);
    expect(await store.blockAt(2)).toBeNull();
    expect(await store.earliestHeight()).toBe(0);

    const book = await store.book(MARKET, 10);
    expect(book.asOfHeight).toBe(1);
    expect(book.asOfHash).toBe(H1);
    expect(book.bids.map((level) => [formatAmount(level.price), formatAmount(level.quantity)])).toEqual([['100', '5']]);

    const position = await store.position(MARKET, ALICE);
    expect(formatAmount(position!.size)).toBe('2');
    expect(formatAmount(position!.entryPrice)).toBe('100');
    expect(position!.blockHeight).toBe(0);
    expect(position!.blockHash).toBe(H0);

    const fills = await store.recentFills(MARKET, 50);
    expect(fills.map((fill) => [fill.blockHash, fill.blockHeight, fill.logIndex, formatAmount(fill.price)])).toEqual([[H0, 0, 1, '100']]);

    // Same-height replay replaces nothing and does not sum.
    const replay = await store.applyBlock(original);
    expect(replay.duplicate).toBe(true);
    expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('5');
    expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe('2');
    expect(await store.recentFills(MARKET, 50)).toHaveLength(1);
    expect((await store.blockAt(0))?.parentHash).toBe(GENESIS);

    // A different hash already canonical at that height is still rejected.
    await expect(
      store.applyBlock({
        chainId: CHAIN,
        height: 0,
        hash: OTHER,
        parentHash: GENESIS,
        timestamp: 1_700_000_000,
        events: [],
      }),
    ).rejects.toThrow(/competing_canonical_block/);
    expect((await store.blockAt(0))?.hash).toBe(H0);

    // The honest next block still extends the chain.
    await store.applyBlock({
      chainId: CHAIN,
      height: 2,
      hash: H2,
      parentHash: H1,
      timestamp: 1_700_000_002,
      events: [],
    });
    expect((await store.head())?.hash).toBe(H2);
    expect((await store.blockAt(0))?.hash).toBe(H0);
    expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('5');
    expect(await store.recentFills(MARKET, 50)).toHaveLength(1);
  });
});
