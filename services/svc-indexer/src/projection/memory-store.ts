import { formatAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  amountOf,
  assertValidBlock,
  nonNegativeAmountOf,
  positiveAmountOf,
  type BookSide,
  type ChainBlock,
  type TakerSide,
} from '../chain/source.js';
import {
  finalizedHeightOf,
  type ApplyOutcome,
  type BookLevel,
  type BookView,
  type FillRecord,
  type PositionRecord,
  type ProjectionStore,
  type StoredBlock,
  type UnwindOutcome,
} from './store.js';

/**
 * In-memory `ProjectionStore` — the reference implementation.
 *
 * Its job is to be OBVIOUSLY correct, so that when it and `PostgresStore`
 * disagree the suite has an opinion about which one is wrong. Both run the same
 * conformance suite (`conformance.ts`), which is the only reason a second
 * implementation earns its keep: a single implementation tested against itself
 * proves that the tests match the code, not that the code matches the design.
 *
 * It is also what makes the reorg tests runnable with no database at all, so
 * the property this service is built around is checked on every `pnpm test`
 * rather than only where Postgres happens to be up.
 */

interface LevelRow {
  market: string;
  side: BookSide;
  /** Canonical decimal string — the identity of a price level. */
  priceKey: string;
  price: Amount;
  quantity: Amount;
  blockHeight: number;
  blockHash: string;
}

interface PositionRow {
  market: string;
  account: string;
  size: Amount;
  entryPrice: Amount;
  blockHeight: number;
  blockHash: string;
}

export class MemoryProjectionStore implements ProjectionStore {
  #blocks = new Map<string, StoredBlock>();
  #levels: LevelRow[] = [];
  #fills: FillRecord[] = [];
  #positions: PositionRow[] = [];

  constructor(readonly chainId: number) {}

  // ── Chain of record ───────────────────────────────────────────────────────

  #canonical(): StoredBlock[] {
    return [...this.#blocks.values()].filter((b) => b.status === 'canonical').sort((a, b) => a.height - b.height);
  }

  async head(): Promise<StoredBlock | null> {
    return this.#canonical().at(-1) ?? null;
  }

  async blockAt(height: number): Promise<StoredBlock | null> {
    return this.#canonical().find((b) => b.height === height) ?? null;
  }

  async earliestHeight(): Promise<number | null> {
    return this.#canonical()[0]?.height ?? null;
  }

  // ── Projection ────────────────────────────────────────────────────────────

  async applyBlock(block: ChainBlock): Promise<ApplyOutcome> {
    assertValidBlock(block);

    if (block.chainId !== this.chainId) {
      throw new Error(`indexer.wrong_chain: block chainId ${block.chainId} does not match store chainId ${this.chainId}`);
    }

    const existing = this.#blocks.get(block.hash);
    const duplicate = existing?.status === 'canonical';

    // A hash already in the map is that block. The map is keyed by hash, so a
    // later set() would replace height and parentHash and leave the level and
    // position rows at the old height. head() would then walk a gap, and the
    // parent the reorg path stored would be gone. Replay at the stored height
    // and parent stays on the idempotent path below.
    if (existing && (existing.height !== block.height || existing.parentHash !== block.parentHash)) {
      throw new Error(
        `indexer.block_hash_relocated: hash ${block.hash} is stored at height ${existing.height} parent ${existing.parentHash} and cannot be applied at height ${block.height} parent ${block.parentHash}`,
      );
    }

    // The competing-block check the partial unique index enforces in Postgres.
    // Modelled here so the two stores fail the same way rather than one of them
    // quietly accepting a state the other cannot represent.
    // Keep validation and the staged commit in one synchronous turn. Awaiting
    // our own reads would let another apply/unwind change this snapshot.
    const canonical = this.#canonical();
    const occupant = canonical.find((row) => row.height === block.height);
    if (occupant && occupant.hash !== block.hash) {
      throw new Error(`indexer.competing_canonical_block: height ${block.height} already holds canonical ${occupant.hash} — unwind first`);
    }

    // Parent link is the store's last line of defence. The indexer checks the
    // forward link; a second writer (or a corrupted apply) must not plant a
    // height that does not hang off the current canonical head.
    const head = canonical.at(-1);
    // Under-tip plant: with head at H, a new block at height < H that we do not
    // already hold poisons the tape while head() still reports the real tip.
    // Re-applying a known hash at that height (idempotent) still uses the
    // occupant/duplicate path above; missing occupant = refuse.
    // height 0 is included — the height>0 parent gates used to skip genesis.
    if (head && block.height < head.height && !occupant) {
      throw new Error(
        `indexer.height_below_tip: cannot apply height ${block.height} when canonical head is ${head.height} — unwind first if reorg, do not plant under tip`,
      );
    }
    if (block.height > 0) {
      const parent = this.#blocks.get(block.parentHash);
      if (head && head.height === block.height - 1 && head.hash !== block.parentHash) {
        throw new Error(
          `indexer.parent_mismatch: block ${block.height} claims parent ${block.parentHash} but canonical head is ${head.hash}`,
        );
      }
      // Gap: applying H+2 while head is H is not a reorg repair path (that is unwind).
      if (head && block.height > head.height + 1) {
        throw new Error(
          `indexer.height_gap: cannot apply height ${block.height} when canonical head is ${head.height} — fill or re-index, do not jump`,
        );
      }
      // Empty store may start at any height (startHeight); only enforce parent
      // presence when we already hold the parent height.
      if (head && block.height === head.height + 1 && !parent) {
        throw new Error(`indexer.parent_missing: block ${block.height} parents ${block.parentHash} which is not in the store`);
      }
    }

    // Both or neither, same contract as Postgres `sql.begin`. The block is
    // not canonical until every event has been projected onto copies. A throw
    // in the loop — amount parser, toLowerCase — drops the copies, so head()
    // does not include this hash and a later apply is not a duplicate of a
    // partial tape. Early refusals above still write nothing.
    const nextBlocks = new Map(this.#blocks);
    nextBlocks.set(block.hash, {
      chainId: block.chainId,
      height: block.height,
      hash: block.hash,
      parentHash: block.parentHash,
      status: 'canonical',
      blockTime: new Date(block.timestamp * 1000),
      eventCount: block.events.length,
    });
    const nextLevels = this.#levels.map((row) => ({ ...row }));
    const nextFills = this.#fills.map((row) => ({ ...row }));
    const nextPositions = this.#positions.map((row) => ({ ...row }));

    for (const event of block.events) {
      switch (event.kind) {
        case 'book_level': {
          const price = positiveAmountOf(event.price, 'book level price');
          const priceKey = formatAmount(price);
          const quantity = nonNegativeAmountOf(event.quantity, 'book level quantity');
          const row = nextLevels.find(
            (l) => l.market === event.market && l.side === event.side && l.priceKey === priceKey && l.blockHeight === block.height,
          );
          // Absolute state: last writer in the block wins, and re-applying the
          // same block reaches the same value. Nothing accumulates.
          if (row) {
            row.quantity = quantity;
            row.blockHash = block.hash;
          } else {
            nextLevels.push({
              market: event.market,
              side: event.side,
              priceKey,
              price,
              quantity,
              blockHeight: block.height,
              blockHash: block.hash,
            });
          }
          break;
        }

        case 'fill': {
          // (block hash, log index) is the chain's own identity for a log —
          // THE reason re-processing a block cannot double-count a trade.
          // Addresses lowercased on write so EIP-55 spellings cannot dual-key.
          const key = (f: FillRecord) => f.blockHash === block.hash && f.logIndex === event.logIndex;
          if (nextFills.some(key)) break;
          nextFills.push({
            blockHeight: block.height,
            blockHash: block.hash,
            logIndex: event.logIndex,
            market: event.market,
            price: positiveAmountOf(event.price, 'fill price'),
            quantity: positiveAmountOf(event.quantity, 'fill quantity'),
            takerSide: event.takerSide as TakerSide,
            maker: event.maker.toLowerCase(),
            taker: event.taker.toLowerCase(),
            blockTime: new Date(block.timestamp * 1000),
          });
          break;
        }

        case 'position': {
          // Same casing law as fills: one account is one account.
          const account = event.account.toLowerCase();
          const row = nextPositions.find((p) => p.market === event.market && p.account === account && p.blockHeight === block.height);
          const size = amountOf(event.size, 'position size');
          const entryPrice = nonNegativeAmountOf(event.entryPrice, 'position entry price');
          if (row) {
            row.size = size;
            row.entryPrice = entryPrice;
            row.blockHash = block.hash;
          } else {
            nextPositions.push({
              market: event.market,
              account,
              size,
              entryPrice,
              blockHeight: block.height,
              blockHash: block.hash,
            });
          }
          break;
        }
      }
    }

    this.#blocks = nextBlocks;
    this.#levels = nextLevels;
    this.#fills = nextFills;
    this.#positions = nextPositions;

    return { duplicate, eventsApplied: block.events.length };
  }

  async unwindTo(height: number): Promise<UnwindOutcome> {
    let blocksOrphaned = 0;
    for (const [hash, block] of this.#blocks) {
      if (block.status === 'canonical' && block.height >= height) {
        this.#blocks.set(hash, { ...block, status: 'orphaned' });
        blocksOrphaned++;
      }
    }

    const levelsBefore = this.#levels.length;
    this.#levels = this.#levels.filter((l) => l.blockHeight < height);
    const fillsBefore = this.#fills.length;
    this.#fills = this.#fills.filter((f) => f.blockHeight < height);
    const positionsBefore = this.#positions.length;
    this.#positions = this.#positions.filter((p) => p.blockHeight < height);

    return {
      blocksOrphaned,
      bookLevelsRemoved: levelsBefore - this.#levels.length,
      fillsRemoved: fillsBefore - this.#fills.length,
      positionsRemoved: positionsBefore - this.#positions.length,
    };
  }

  async prune(throughHeight: number): Promise<number> {
    let removed = 0;

    const keepNewest = <T extends { blockHeight: number }>(rows: T[], keyOf: (row: T) => string): T[] => {
      const newest = new Map<string, number>();
      for (const row of rows) {
        if (row.blockHeight > throughHeight) continue;
        const key = keyOf(row);
        const current = newest.get(key);
        if (current === undefined || row.blockHeight > current) newest.set(key, row.blockHeight);
      }
      return rows.filter((row) => row.blockHeight > throughHeight || newest.get(keyOf(row)) === row.blockHeight);
    };

    const levelsBefore = this.#levels.length;
    this.#levels = keepNewest(this.#levels, (l) => `${l.market}|${l.side}|${l.priceKey}`);
    removed += levelsBefore - this.#levels.length;

    const positionsBefore = this.#positions.length;
    // Account already lowercased on write; key still lowercases so prune cannot
    // dual-retain legacy mixed-case rows if any ever existed in memory.
    this.#positions = keepNewest(this.#positions, (p) => `${p.market}|${p.account.toLowerCase()}`);
    removed += positionsBefore - this.#positions.length;

    // Orphaned block records are kept: unwind already removed what they wrote,
    // and the explorer lists a reorged block with its badge for good.

    return removed;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Newest version per key, which is what "current" means in this design. */
  #currentLevels(market: string, side: BookSide, atHeight: number): LevelRow[] {
    const newest = new Map<string, LevelRow>();
    for (const row of this.#levels) {
      if (row.market !== market || row.side !== side || row.blockHeight > atHeight) continue;
      const held = newest.get(row.priceKey);
      if (!held || row.blockHeight > held.blockHeight) newest.set(row.priceKey, row);
    }
    return [...newest.values()];
  }

  async book(market: string, depth: number, atHeight?: number): Promise<BookView> {
    // Pinned read: the as-of block must be a canonical block we hold. Without
    // one there is nothing to name, so the book is empty with a null as-of.
    // No await between the lookup and the scan: see `bookFinalized`.
    const canonical = this.#canonical();
    const asOf = atHeight === undefined ? (canonical.at(-1) ?? null) : (canonical.find((b) => b.height === atHeight) ?? null);
    return this.#bookAt(market, depth, asOf);
  }

  async bookFinalized(market: string, depth: number, finalityDepth: number): Promise<BookView> {
    // One synchronous turn: nothing can apply, unwind or prune between the head
    // read, the finalized-block lookup and the level scan. This is the in-memory
    // form of the Postgres REPEATABLE READ snapshot.
    const canonical = this.#canonical();
    const height = finalizedHeightOf(canonical.at(-1) ?? null, finalityDepth);
    const asOf = height === null ? null : (canonical.find((b) => b.height === height) ?? null);
    return this.#bookAt(market, depth, asOf);
  }

  #bookAt(market: string, depth: number, asOf: StoredBlock | null): BookView {
    const ceiling = asOf?.height ?? -1;

    const side = (s: BookSide, direction: 1 | -1): BookLevel[] =>
      this.#currentLevels(market, s, ceiling)
        // Quantity 0 is an empty level, and it is filtered AFTER the newest
        // version is chosen — a level emptied in block N must not fall back to
        // its depth in block N-1.
        .filter((row) => row.quantity > 0n)
        .sort((a, b) => (a.price === b.price ? 0 : a.price > b.price ? direction : -direction))
        .slice(0, depth)
        .map((row) => ({ price: row.price, quantity: row.quantity }));

    return {
      market,
      chainId: this.chainId,
      asOfHeight: asOf?.height ?? null,
      asOfHash: asOf?.hash ?? null,
      bids: side('bid', -1),
      asks: side('ask', 1),
    };
  }

  #newestFirst(fills: readonly FillRecord[]): FillRecord[] {
    return [...fills].sort((a, b) => b.blockHeight - a.blockHeight || b.logIndex - a.logIndex);
  }

  /** Fills whose block is no longer canonical are not fills. Unknown ≠ success. */
  #onCanonicalChain(fill: FillRecord): boolean {
    const block = this.#blocks.get(fill.blockHash);
    return block !== undefined && block.status === 'canonical';
  }

  async recentFills(market: string, limit: number): Promise<readonly FillRecord[]> {
    return this.#newestFirst(this.#fills.filter((f) => f.market === market && this.#onCanonicalChain(f))).slice(0, limit);
  }

  async fillsForAccount(account: string, limit: number): Promise<readonly FillRecord[]> {
    const lower = account.toLowerCase();
    return this.#newestFirst(
      this.#fills.filter((f) => this.#onCanonicalChain(f) && (f.maker.toLowerCase() === lower || f.taker.toLowerCase() === lower)),
    ).slice(0, limit);
  }

  #currentPositions(): PositionRow[] {
    const newest = new Map<string, PositionRow>();
    for (const row of this.#positions) {
      const key = `${row.market}|${row.account.toLowerCase()}`;
      const held = newest.get(key);
      if (!held || row.blockHeight > held.blockHeight) newest.set(key, row);
    }
    return [...newest.values()];
  }

  async position(market: string, account: string): Promise<PositionRecord | null> {
    const lower = account.toLowerCase();
    return this.#currentPositions().find((p) => p.market === market && p.account.toLowerCase() === lower) ?? null;
  }

  async positionsOf(account: string, limit: number): Promise<readonly PositionRecord[]> {
    const lower = account.toLowerCase();
    return this.#currentPositions()
      .filter((p) => p.account.toLowerCase() === lower)
      .sort((a, b) => a.market.localeCompare(b.market))
      .slice(0, limit);
  }

  async markets(limit: number): Promise<readonly string[]> {
    const seen = new Set<string>();
    for (const row of this.#levels) seen.add(row.market);
    for (const row of this.#fills) seen.add(row.market);
    for (const row of this.#positions) seen.add(row.market);
    return [...seen].sort().slice(0, limit);
  }
}
