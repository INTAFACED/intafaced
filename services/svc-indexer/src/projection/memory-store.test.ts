import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { MemoryProjectionStore } from './memory-store.js';
import type { ChainBlock } from '../chain/source.js';
import { CHAIN_ID, runProjectionConformance } from '../testing/conformance.js';

/**
 * The reference implementation, under the same suite the Postgres store runs.
 *
 * Requires nothing: no database, no chain, no network. That is deliberate —
 * the reorg property this service is built around is checked on every
 * `pnpm test`, not only where infrastructure happens to be up.
 */
runProjectionConformance('MemoryProjectionStore', async () => {
  let store = new MemoryProjectionStore(CHAIN_ID);
  return {
    get store() {
      return store;
    },
    reset: async () => {
      store = new MemoryProjectionStore(CHAIN_ID);
    },
  };
});

const MARKET = 'IFC-USD';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc';
const GENESIS = '0x' + '00'.repeat(32);
const H0 = '0x' + '11'.repeat(32);
const H1 = '0x' + '22'.repeat(32);

/**
 * `assertAddress` only runs the address regex, which stringifies. The event
 * loop then calls `toLowerCase`. A throw there is after earlier events.
 */
function addressThatThrowsOnLowerCase(): string {
  return {
    toString() {
      return CAROL;
    },
    toLowerCase() {
      throw new TypeError('taker toLowerCase failed');
    },
  } as unknown as string;
}

describe('MemoryProjectionStore · applyBlock commits the block and its events together', () => {
  it('rolls back a throw in the event loop, then a clean apply of that hash commits once', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const prior: ChainBlock = {
      chainId: CHAIN_ID,
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
    await store.applyBlock(prior);

    const poisoned: ChainBlock = {
      chainId: CHAIN_ID,
      height: 1,
      hash: H1,
      parentHash: H0,
      timestamp: 1_700_000_001,
      events: [
        { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: '100', quantity: '9' },
        {
          kind: 'fill',
          logIndex: 1,
          market: MARKET,
          price: '101',
          quantity: '1',
          takerSide: 'buy',
          maker: ALICE,
          taker: BOB,
        },
        { kind: 'position', logIndex: 2, market: MARKET, account: BOB, size: '1', entryPrice: '100' },
        {
          kind: 'fill',
          logIndex: 3,
          market: MARKET,
          price: '100',
          quantity: '1',
          takerSide: 'sell',
          maker: ALICE,
          taker: addressThatThrowsOnLowerCase(),
        },
      ],
    };

    await expect(store.applyBlock(poisoned)).rejects.toThrow(/toLowerCase/);

    expect((await store.head())?.hash).toBe(H0);
    expect((await store.head())?.height).toBe(0);
    expect(await store.blockAt(1)).toBeNull();
    expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('5');
    expect((await store.book(MARKET, 10)).bids).toHaveLength(1);
    const fillsAfterThrow = await store.recentFills(MARKET, 50);
    expect(fillsAfterThrow.map((fill) => [fill.blockHash, fill.logIndex, formatAmount(fill.price)])).toEqual([[H0, 1, '100']]);
    expect(await store.position(MARKET, BOB)).toBeNull();
    expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe('2');
    expect((await store.position(MARKET, ALICE))!.blockHash).toBe(H0);

    // Same hash, different fill price. A leftover poison fill shares
    // (hash, log index) and would keep 101 instead of inserting 100.
    const clean: ChainBlock = {
      chainId: CHAIN_ID,
      height: 1,
      hash: H1,
      parentHash: H0,
      timestamp: 1_700_000_001,
      events: [
        { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: '100', quantity: '7' },
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
        { kind: 'position', logIndex: 2, market: MARKET, account: BOB, size: '1', entryPrice: '100' },
      ],
    };

    const committed = await store.applyBlock(clean);
    expect(committed.duplicate).toBe(false);
    expect(committed.eventsApplied).toBe(3);
    expect((await store.head())?.hash).toBe(H1);
    expect((await store.head())?.eventCount).toBe(3);
    expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('7');
    expect((await store.recentFills(MARKET, 50)).map((fill) => [fill.blockHash, fill.logIndex, formatAmount(fill.price)])).toEqual([
      [H1, 1, '100'],
      [H0, 1, '100'],
    ]);
    expect(formatAmount((await store.position(MARKET, BOB))!.size)).toBe('1');
    expect((await store.position(MARKET, BOB))!.blockHash).toBe(H1);
    expect((await store.position(MARKET, ALICE))!.blockHash).toBe(H0);

    const replay = await store.applyBlock(clean);
    expect(replay.duplicate).toBe(true);
    expect(replay.eventsApplied).toBe(3);
    expect(await store.recentFills(MARKET, 50)).toHaveLength(2);
    expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('7');
    expect(formatAmount((await store.position(MARKET, BOB))!.size)).toBe('1');
    expect((await store.head())?.hash).toBe(H1);
  });
});
