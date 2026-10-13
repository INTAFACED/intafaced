import { describe, expect, it, beforeEach } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { MemoryChainSource } from '../chain/memory-source.js';
import type { ChainEvent } from '../chain/source.js';
import { Indexer, ReorgTooDeepError } from '../indexer.js';
import type { ProjectionStore } from '../projection/store.js';

/**
 * THE PROJECTION CONFORMANCE SUITE.
 *
 * Every `ProjectionStore` runs this file unmodified — the in-memory reference
 * and the Postgres store alike. That is the only reason a second implementation
 * earns its keep: a single implementation tested against itself proves the
 * tests match the code, not that the code matches the design. If the two ever
 * disagree about anything in here, one of them is wrong and this file says
 * which behaviour is correct.
 *
 * The reorg section is the reason this service is shaped the way it is. Read
 * `projection/store.ts` for the argument; these are the assertions that hold it
 * to it. The scenarios are driven through the real `Indexer` rather than by
 * calling `unwindTo` directly, because the failure being defended against is
 * "the indexer never noticed", and a test that calls the repair by hand has
 * skipped the part that goes wrong.
 */

export const CHAIN_ID = 31337;

const ALICE = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = '0xBBbBbBBbbBbBbbBbbbbbBBbBbbbbBbBbBbbBBbB0';

export interface ProjectionHarness {
  readonly store: ProjectionStore;
  /** Empty the projection between tests. */
  reset(): Promise<void>;
}

// ── Event builders ──────────────────────────────────────────────────────────

let logIndex = 0;
/** Log indexes must be unique within a block; the builders just count. */
function nextLog(): number {
  return logIndex++;
}
function block(...events: ChainEvent[]): ChainEvent[] {
  logIndex = 0;
  return events;
}

function level(market: string, side: 'bid' | 'ask', price: string, quantity: string): ChainEvent {
  return { kind: 'book_level', logIndex: nextLog(), market, side, price, quantity };
}
function fill(market: string, price: string, quantity: string, takerSide: 'buy' | 'sell' = 'buy'): ChainEvent {
  return { kind: 'fill', logIndex: nextLog(), market, price, quantity, takerSide, maker: ALICE, taker: BOB };
}
function position(market: string, account: string, size: string, entryPrice: string): ChainEvent {
  return { kind: 'position', logIndex: nextLog(), market, account, size, entryPrice };
}

/** `[['100','5']]` — the shape assertions read most cleanly against. */
function levels(rows: readonly { price: bigint; quantity: bigint }[]): string[][] {
  return rows.map((l) => [formatAmount(l.price), formatAmount(l.quantity)]);
}

const MARKET = 'IFC-USD';

export function runProjectionConformance(label: string, makeHarness: () => Promise<ProjectionHarness>): void {
  describe(`${label} — projection`, () => {
    let harness: ProjectionHarness;
    let store: ProjectionStore;
    let source: MemoryChainSource;
    let indexer: Indexer;

    const newIndexer = (finalityDepth = 64) => new Indexer({ source, store, finalityDepth, ingestEnabled: () => true, startHeight: 0 });

    beforeEach(async () => {
      harness ??= await makeHarness();
      // Reset BEFORE reading `store`: a harness may hand back a fresh instance.
      await harness.reset();
      store = harness.store;
      source = new MemoryChainSource(CHAIN_ID);
      indexer = newIndexer();
    });

    // ── Baseline ──────────────────────────────────────────────────────────

    it('serves an empty book with no head rather than failing', async () => {
      const view = await store.book(MARKET, 10);
      expect(view).toMatchObject({ market: MARKET, chainId: CHAIN_ID, asOfHeight: null, asOfHash: null });
      expect(view.bids).toEqual([]);
      expect(view.asks).toEqual([]);
      expect(await store.markets(10)).toEqual([]);
    });

    it('projects levels, fills and positions from a block', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'), level(MARKET, 'ask', '101', '3'), fill(MARKET, '100.5', '2')));
      source.append(block(position(MARKET, ALICE, '-4', '100.25')));

      const result = await indexer.sync();
      expect(result.blocksApplied).toBe(2);

      const view = await store.book(MARKET, 10);
      expect(levels(view.bids)).toEqual([['100', '5']]);
      expect(levels(view.asks)).toEqual([['101', '3']]);
      expect(view.asOfHeight).toBe(1);

      const tape = await store.recentFills(MARKET, 10);
      expect(tape).toHaveLength(1);
      expect(formatAmount(tape[0]!.price)).toBe('100.5');
      expect(formatAmount(tape[0]!.quantity)).toBe('2');

      const pos = await store.position(MARKET, ALICE);
      // Signed: short four, and it survives the round trip as a bigint.
      expect(formatAmount(pos!.size)).toBe('-4');
      expect(formatAmount(pos!.entryPrice)).toBe('100.25');

      expect(await store.markets(10)).toEqual([MARKET]);
    });

    it('orders bids descending and asks ascending, and honours depth', async () => {
      source.append(
        block(
          level(MARKET, 'bid', '99', '1'),
          level(MARKET, 'bid', '100', '2'),
          level(MARKET, 'bid', '98', '3'),
          level(MARKET, 'ask', '103', '1'),
          level(MARKET, 'ask', '101', '2'),
          level(MARKET, 'ask', '102', '3'),
        ),
      );
      await indexer.sync();

      const view = await store.book(MARKET, 2);
      expect(levels(view.bids)).toEqual([
        ['100', '2'],
        ['99', '1'],
      ]);
      expect(levels(view.asks)).toEqual([
        ['101', '2'],
        ['102', '3'],
      ]);
    });

    it('treats a level as ABSOLUTE, not a delta', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '100', '9')));
      await indexer.sync();

      // 9, never 14. The whole idempotency and reorg design rests on this.
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '9']]);
    });

    it('removes a level at quantity zero, and does not fall back to its old depth', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'), level(MARKET, 'bid', '99', '1')));
      source.append(block(level(MARKET, 'bid', '100', '0')));
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['99', '1']]);
    });

    it('keys price levels by VALUE, so 100 and 100.000 are one level', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '100.000', '7')));
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '7']]);
    });

    it('carries 18 decimal places without going through a float', async () => {
      // 0.1 + 0.2 in this quantity would not be 0.3 if anything here were a
      // `number`, and the last digit would be lost outright.
      source.append(block(level(MARKET, 'bid', '0.000000000000000001', '123456789.123456789123456789')));
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['0.000000000000000001', '123456789.123456789123456789']]);
    });

    // ── Idempotency ───────────────────────────────────────────────────────

    it('re-applying the same block changes nothing — levels, fills or positions', async () => {
      const b0 = source.append(block(level(MARKET, 'bid', '100', '5'), fill(MARKET, '100', '2'), position(MARKET, ALICE, '2', '100')));
      await indexer.sync();

      const before = {
        book: levels((await store.book(MARKET, 10)).bids),
        fills: (await store.recentFills(MARKET, 50)).length,
        size: formatAmount((await store.position(MARKET, ALICE))!.size),
      };

      // Straight at the store, twice, the way a redelivery or a crash-restart
      // replay would arrive. No skip branch protects this — every write on the
      // path is idempotent, which is the property being asserted.
      const first = await store.applyBlock(b0);
      const second = await store.applyBlock(b0);
      expect(first.duplicate).toBe(true);
      expect(second.duplicate).toBe(true);

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual(before.book);
      expect(await store.recentFills(MARKET, 50)).toHaveLength(before.fills);
      expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe(before.size);
    });

    it('a second sync over an unchanged chain applies nothing', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'), fill(MARKET, '100', '2')));
      source.append(block(fill(MARKET, '101', '1')));

      expect((await indexer.sync()).blocksApplied).toBe(2);
      expect((await indexer.sync()).blocksApplied).toBe(0);
      expect(await store.recentFills(MARKET, 50)).toHaveLength(2);
    });

    it('refuses a second canonical block at a height that is already occupied', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      await indexer.sync();

      const impostor = {
        chainId: CHAIN_ID,
        height: 0,
        hash: `0x${'1'.repeat(64)}`,
        parentHash: `0x${'2'.repeat(64)}`,
        timestamp: 1_700_000_000,
        events: [],
      };
      // Two canonical blocks at one height means two answers to every read
      // below it. The database holds this invariant; the memory store models it.
      await expect(store.applyBlock(impostor)).rejects.toThrow();
    });

    // ── Book as of a height (the finalized view) ──────────────────────────

    it('serves the book AS OF a height: later versions and later levels stay out, and the as-of is that block', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'), level(MARKET, 'ask', '101', '3'))); // 0
      source.append(block(level(MARKET, 'bid', '100', '9'))); // 1
      source.append(block(level(MARKET, 'bid', '100', '12'), level(MARKET, 'ask', '102', '4'))); // 2
      await indexer.sync();

      const at1 = await store.book(MARKET, 10, 1);
      expect(levels(at1.bids)).toEqual([['100', '9']]);
      expect(levels(at1.asks)).toEqual([['101', '3']]);
      expect(at1.asOfHeight).toBe(1);
      expect(at1.asOfHash).toBe((await store.blockAt(1))!.hash);

      // Unpinned is still the head; at the head height the two agree.
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '12']]);
      expect(await store.book(MARKET, 10, 2)).toEqual(await store.book(MARKET, 10));
    });

    it('a level emptied above the height is still there at the height; one emptied at it is gone', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'), level(MARKET, 'bid', '99', '1'))); // 0
      source.append(block(level(MARKET, 'bid', '99', '0'))); // 1 empties 99
      source.append(block(level(MARKET, 'bid', '100', '0'))); // 2 empties 100
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10, 0)).bids)).toEqual([
        ['100', '5'],
        ['99', '1'],
      ]);
      expect(levels((await store.book(MARKET, 10, 1)).bids)).toEqual([['100', '5']]);
      expect(levels((await store.book(MARKET, 10, 2)).bids)).toEqual([]);
    });

    it('a height with no canonical block is an empty book with a null as-of, never the nearest block', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5'))); // 0
      source.append(block(level(MARKET, 'bid', '100', '6'))); // 1
      await indexer.sync();

      for (const height of [2, 50]) {
        const view = await store.book(MARKET, 10, height);
        expect(view).toMatchObject({ market: MARKET, chainId: CHAIN_ID, asOfHeight: null, asOfHash: null });
        expect(view.bids).toEqual([]);
        expect(view.asks).toEqual([]);
      }
      // And on an empty index.
      await harness.reset();
      expect((await harness.store.book(MARKET, 10, 0)).asOfHeight).toBeNull();
    });

    it('a reorg above the height leaves the book at that height unchanged; one at it changes it', async () => {
      for (const qty of ['1', '2', '3', '4', '5']) source.append(block(level(MARKET, 'bid', '100', qty))); // 0..4
      await indexer.sync();
      const before = await store.book(MARKET, 10, 2);
      expect(levels(before.bids)).toEqual([['100', '3']]);

      // Fork at 2: blocks 3 and 4 are replaced, and one adds a new level.
      source.reorg(2, [block(level(MARKET, 'bid', '100', '40'), level(MARKET, 'ask', '103', '1')), block()]);
      expect((await indexer.sync()).reorgs).toBe(1);

      expect(await store.book(MARKET, 10, 2)).toEqual(before);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '40']]);

      // Fork at 1 replaces block 2 itself, so the book at 2 now differs and
      // names the new block.
      source.reorg(1, [block(level(MARKET, 'bid', '100', '77'))]);
      await indexer.sync();
      const after = await store.book(MARKET, 10, 2);
      expect(levels(after.bids)).toEqual([['100', '77']]);
      expect(after.asOfHash).not.toBe(before.asOfHash);
    });

    it('stays exact at the prune horizon: pruning through H does not change the book at H', async () => {
      for (const qty of ['1', '2', '3', '4', '5', '6'])
        source.append(block(level(MARKET, 'bid', '100', qty), level(MARKET, 'ask', '101', qty)));
      await indexer.sync();

      const before = await store.book(MARKET, 10, 3);
      expect(levels(before.bids)).toEqual([['100', '4']]);
      expect(await store.prune(3)).toBeGreaterThan(0);
      expect(await store.book(MARKET, 10, 3)).toEqual(before);
    });

    // ── Reorg ─────────────────────────────────────────────────────────────

    it('unwinds an orphaned block and matches the NEW canonical chain', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '100', '9'), fill(MARKET, '100', '1')));
      source.append(block(level(MARKET, 'bid', '100', '12'), fill(MARKET, '101', '2')));
      await indexer.sync();
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '12']]);
      expect(await store.recentFills(MARKET, 50)).toHaveLength(2);

      // Height 1 survives; height 2 is replaced by a different block.
      source.reorg(1, [block(level(MARKET, 'bid', '100', '7'), fill(MARKET, '99', '3'))]);

      const result = await indexer.sync();
      expect(result.reorgs).toBe(1);

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '7']]);
      const tape = await store.recentFills(MARKET, 50);
      expect(tape.map((f) => formatAmount(f.price))).toEqual(['99', '100']);

      const head = await store.head();
      expect(head!.hash).toBe((await source.blockAt(2))!.hash);
    });

    /**
     * THE ONE THAT MATTERS.
     *
     * The replacement branch does not mention the level at all. A projection
     * that keeps only "the current value" has nothing to restore and keeps
     * serving 12 — a price that was never on the canonical chain, with no
     * error, no gap and no alert. Versioned rows make the previous value
     * current again by deletion alone.
     */
    it('restores the previous version of a level the new branch never mentions', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '100', '9')));
      source.append(block(level(MARKET, 'bid', '100', '12')));
      await indexer.sync();
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '12']]);

      // The new height-2 block touches a position and nothing else.
      source.reorg(1, [block(position(MARKET, BOB, '1', '100'))]);
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '9']]);
    });

    it('drops a level that only ever existed on the orphaned branch', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '250', '1')));
      await indexer.sync();
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([
        ['250', '1'],
        ['100', '5'],
      ]);

      source.reorg(0, [block()]);
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '5']]);
    });

    it('deletes fills and positions from the orphaned branch', async () => {
      source.append(block(fill(MARKET, '100', '1'), position(MARKET, ALICE, '1', '100')));
      source.append(block(fill(MARKET, '101', '5'), position(MARKET, ALICE, '6', '100.8')));
      await indexer.sync();
      expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe('6');

      source.reorg(0, [block(fill(MARKET, '102', '2'))]);
      await indexer.sync();

      const tape = await store.recentFills(MARKET, 50);
      expect(tape.map((f) => formatAmount(f.price))).toEqual(['102', '100']);
      // The position event on the dead branch is gone; the surviving one stands.
      expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe('1');
    });

    it('notices a reorg that REPLACES the tip without extending the chain', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      source.append(block(level(MARKET, 'bid', '100', '9')));
      await indexer.sync();

      // Same height, different block. An indexer that only ever asks for
      // `head + 1` never sees this, because there is no `head + 1`.
      source.reorg(0, [block(level(MARKET, 'bid', '100', '3'))]);
      const result = await indexer.sync();

      expect(result.reorgs).toBe(1);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '3']]);
      expect((await store.head())!.height).toBe(1);
    });

    it('follows the chain back to a branch it previously orphaned', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      const original = source.append(block(level(MARKET, 'bid', '100', '9')));
      await indexer.sync();

      source.reorg(0, [block(level(MARKET, 'bid', '100', '3'))], 'branch-b');
      await indexer.sync();
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '3']]);

      // …and back again. The original block's hash is recorded orphaned; it has
      // to come home canonical rather than collide with its own record.
      source.reorg(0, [original.events], '');
      await indexer.sync();

      expect((await store.head())!.hash).toBe(original.hash);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '9']]);
    });

    it('repairs a multi-block reorg in one pass', async () => {
      source.append(block(level(MARKET, 'bid', '100', '1')));
      for (const qty of ['2', '3', '4', '5']) source.append(block(level(MARKET, 'bid', '100', qty)));
      await indexer.sync();
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '5']]);

      source.reorg(1, [block(level(MARKET, 'bid', '100', '40')), block(), block(level(MARKET, 'bid', '100', '42'))]);
      const result = await indexer.sync();

      expect(result.reorgs).toBe(1);
      expect(result.blocksApplied).toBe(3);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '42']]);
      expect((await store.head())!.height).toBe(4);
    });

    it('refuses, and halts, when the reorg is deeper than retained history', async () => {
      source.append(block(level(MARKET, 'bid', '100', '1')));
      for (let i = 0; i < 9; i++) source.append(block(level(MARKET, 'bid', '100', String(i + 2))));

      const shallow = newIndexer(2);
      await shallow.sync();
      expect((await store.head())!.height).toBe(9);

      // A fork eight blocks below a two-block memory. The versions that would
      // be needed to fall back are gone, so guessing would mean serving a book
      // with holes in it and no way to know.
      source.reorg(1, [block(level(MARKET, 'bid', '100', '99'))]);

      await expect(shallow.sync()).rejects.toBeInstanceOf(ReorgTooDeepError);
      expect(shallow.halted).not.toBeNull();
      expect(shallow.lastError).not.toBeNull();
      // A halted indexer stops advancing rather than limping on.
      expect((await shallow.sync()).idle).toBe('halted');
      // Idle-halted must NOT wipe lastError — status needs both halt and why.
      expect(shallow.lastError).not.toBeNull();
      expect(shallow.halted).not.toBeNull();
    });

    /**
     * README: resume is for AFTER re-index, not instead of it. Without this
     * path a deep halt is permanent even when an operator has repaired the
     * projection — sync would keep returning idle:halted forever.
     */
    it('resume after a deep halt clears the halt so a later pass can run', async () => {
      source.append(block(level(MARKET, 'bid', '100', '1')));
      for (let i = 0; i < 9; i++) source.append(block(level(MARKET, 'bid', '100', String(i + 2))));

      const shallow = newIndexer(2);
      await shallow.sync();
      source.reorg(1, [block(level(MARKET, 'bid', '100', '99'))]);
      await expect(shallow.sync()).rejects.toBeInstanceOf(ReorgTooDeepError);
      expect(shallow.halted).not.toBeNull();
      expect(shallow.lastError).not.toBeNull();

      shallow.resume();
      expect(shallow.halted).toBeNull();
      expect(shallow.lastError).toBeNull();
      // The deep fork is still present — next pass must ATTEMPT (throw again),
      // not silently idle as halted.
      await expect(shallow.sync()).rejects.toBeInstanceOf(ReorgTooDeepError);
      expect(shallow.halted).not.toBeNull();
    });

    // ── Pruning ───────────────────────────────────────────────────────────

    it('prunes superseded versions without changing what is served', async () => {
      for (const qty of ['1', '2', '3', '4', '5', '6']) source.append(block(level(MARKET, 'bid', '100', qty)));
      await indexer.sync();

      const before = levels((await store.book(MARKET, 10)).bids);
      const removed = await store.prune(3);

      expect(removed).toBeGreaterThan(0);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual(before);
    });

    it('keeps enough history after a prune to still unwind above the horizon', async () => {
      for (const qty of ['1', '2', '3', '4', '5', '6']) source.append(block(level(MARKET, 'bid', '100', qty)));
      await indexer.sync();
      await store.prune(3);

      // Fork at height 4, i.e. above the pruned horizon: block 4's value must
      // still be there to fall back to.
      source.reorg(4, [block(position(MARKET, ALICE, '1', '100'))]);
      await indexer.sync();

      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '5']]);
    });

    // ── Kill-switch ───────────────────────────────────────────────────────

    it('stops advancing when the ingest kill-switch is off, and keeps serving', async () => {
      source.append(block(level(MARKET, 'bid', '100', '5')));
      await indexer.sync();

      let enabled = false;
      const switched = new Indexer({ source, store, finalityDepth: 64, ingestEnabled: () => enabled, startHeight: 0 });
      source.append(block(level(MARKET, 'bid', '100', '9')));

      expect((await switched.sync()).idle).toBe('disabled');
      // Reads are untouched: an operator can pause OUR ingestion, never a
      // user's access to what is already projected.
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '5']]);

      enabled = true;
      expect((await switched.sync()).blocksApplied).toBe(1);
      expect(levels((await store.book(MARKET, 10)).bids)).toEqual([['100', '9']]);
    });

    it('reports no chain rather than failing when the source has none', async () => {
      const empty = new Indexer({
        source: new MemoryChainSource(CHAIN_ID),
        store,
        finalityDepth: 64,
        ingestEnabled: () => true,
      });
      expect((await empty.sync()).idle).toBe('no-chain');
    });

    // ── Account views ─────────────────────────────────────────────────────

    it('finds an account tape from either side of a fill, case-insensitively', async () => {
      source.append(block(fill(MARKET, '100', '1'), fill(MARKET, '101', '2', 'sell')));
      await indexer.sync();

      expect(await store.fillsForAccount(ALICE.toLowerCase(), 10)).toHaveLength(2);
      expect(await store.fillsForAccount(BOB.toUpperCase(), 10)).toHaveLength(2);
      expect(await store.fillsForAccount('0x' + '9'.repeat(40), 10)).toHaveLength(0);
    });

    it('lists an account positions across markets, newest version only', async () => {
      source.append(block(position('A-USD', ALICE, '1', '10'), position('B-USD', ALICE, '2', '20')));
      source.append(block(position('A-USD', ALICE, '5', '11')));
      await indexer.sync();

      const rows = await store.positionsOf(ALICE, 10);
      expect(rows.map((p) => [p.market, formatAmount(p.size)])).toEqual([
        ['A-USD', '5'],
        ['B-USD', '2'],
      ]);
    });

    /**
     * EIP-55 checksum casing is presentation, not identity. Stores that keep
     * the write spelling as the key split one account into two; Postgres
     * `DISTINCT ON (market, account)` is case-sensitive, so mixed-case writes
     * would dual-key and serve two "current" sizes. Lowercase on write makes
     * that state unrepresentable — same as EVM decode already does.
     */
    it('treats mixed-case address spellings as one account — newest size wins', async () => {
      const mixed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
      const lower = mixed.toLowerCase();
      const upper = ('0x' + mixed.slice(2).toUpperCase()) as string;

      source.append(block(position(MARKET, mixed, '1', '100')));
      source.append(block(position(MARKET, lower, '9', '101')));
      await indexer.sync();

      // Query with any casing → newest size, single current row.
      for (const query of [mixed, lower, upper]) {
        const pos = await store.position(MARKET, query);
        expect(pos, `position via ${query}`).not.toBeNull();
        expect(formatAmount(pos!.size)).toBe('9');
        expect(pos!.account).toBe(lower);
        expect(await store.positionsOf(query, 10)).toHaveLength(1);
      }
    });

    it('refuses applyBlock when block.chainId does not match the store', async () => {
      const foreign = {
        chainId: CHAIN_ID + 1,
        height: 0,
        hash: `0x${'a'.repeat(64)}`,
        parentHash: `0x${'b'.repeat(64)}`,
        timestamp: 1_700_000_000,
        events: [] as ChainEvent[],
      };
      await expect(store.applyBlock(foreign)).rejects.toThrow(/chainId|chain_id|wrong.?chain/i);
      expect(await store.head()).toBeNull();
    });
  });
}
