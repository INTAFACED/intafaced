import type { Amount } from '@intafaced/ledger-client/money';
import type { BlockHash, BookSide, ChainBlock, TakerSide } from '../chain/source.js';

/**
 * THE PROJECTION STORE — the read model, and the reorg contract.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS INTERFACE IS SHAPED THE WAY IT IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * Chain data is not final on arrival. A projection that applies a block by
 * overwriting the current value cannot undo it, because the value it replaced
 * is gone. After a reorg it serves a price that was never on the canonical
 * chain, and nothing about it looks broken — no error, no gap, no alert. The
 * user sees a number. That is the failure this interface exists to make
 * impossible.
 *
 * ── The option not taken: confirmation depth alone ─────────────────────────
 *
 * The usual answer is "only project blocks that are N deep". It is not a reorg
 * strategy, it is a probability knob:
 *
 *   · it makes the read model N blocks stale, always, including the 99.9% of
 *     the time when nothing reorgs. For an order book that is the whole product
 *   · any N is still wrong for a reorg of depth N+1, and the failure mode is
 *     unchanged — silently serving a doomed branch
 *   · it does not answer the question. It reduces how often the question is
 *     asked
 *
 * ── The option taken: provenance + unwind ──────────────────────────────────
 *
 * Every projected row records the block that wrote it, and the state tables are
 * VERSIONED BY BLOCK HEIGHT — one row per (key, block) rather than one row per
 * key. "Current" is the newest version.
 *
 * Repairing a reorg is then `unwindTo(forkHeight + 1)`: delete the versions
 * above the fork. The previous version becomes current again by itself. No
 * replay, no compensating writes, no arithmetic that can be off by one — the
 * repair is a DELETE, and a DELETE is hard to get subtly wrong.
 *
 * The projection is therefore correct at every depth, and blocks can be
 * projected the moment they are seen. Confirmation depth survives as what it
 * actually is: the retention threshold for `prune`, i.e. the deepest reorg
 * repairable without a full re-index, plus a confidence number on reads.
 *
 * ── The cost, stated ───────────────────────────────────────────────────────
 *
 * Version rows, and a `DISTINCT ON` on every book read instead of a plain
 * scan. `prune` bounds the first; the second is served by an index whose
 * leading columns are exactly the DISTINCT ON key. The trade is deliberate:
 * this is a read model, and a read model that is fast and wrong is worth less
 * than one that is fast enough and right.
 *
 * ── What is NOT solved here ────────────────────────────────────────────────
 *
 * A reorg deeper than retained history. `findForkPoint` in `indexer.ts` refuses
 * rather than guesses — see the argument there.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prices, quantities and sizes are `Amount` (scaled bigint) across this
 * interface, decimal strings on the wire, and `numeric(38,18)` in Postgres.
 * Never `number`: an order book is nothing but sums, and a float sums
 * 0.1 + 0.2 to something that is not 0.3.
 */

/**
 * The height below which blocks are treated as final: head minus the finality
 * depth, floored at 0. The ONE definition — `status.finalizedHeight` publishes
 * it, `bookFinalized` reads at it, and `Indexer` prunes through it, so the three
 * can never disagree about which block is safe to price from. `null` on an
 * empty index.
 */
export function finalizedHeightOf(head: { readonly height: number } | null, finalityDepth: number): number | null {
  return head ? Math.max(0, head.height - finalityDepth) : null;
}

export type BlockStatus = 'canonical' | 'orphaned';

export interface StoredBlock {
  readonly chainId: number;
  readonly height: number;
  readonly hash: BlockHash;
  readonly parentHash: BlockHash;
  readonly status: BlockStatus;
  readonly blockTime: Date;
  readonly eventCount: number;
}

export interface BookLevel {
  readonly price: Amount;
  readonly quantity: Amount;
}

export interface BookView {
  readonly market: string;
  readonly chainId: number;
  /** The canonical head this view is current as of. `null` on an empty index. */
  readonly asOfHeight: number | null;
  readonly asOfHash: BlockHash | null;
  /** Descending by price. */
  readonly bids: readonly BookLevel[];
  /** Ascending by price. */
  readonly asks: readonly BookLevel[];
}

export interface FillRecord {
  readonly blockHeight: number;
  readonly blockHash: BlockHash;
  readonly logIndex: number;
  readonly market: string;
  readonly price: Amount;
  readonly quantity: Amount;
  readonly takerSide: TakerSide;
  readonly maker: string;
  readonly taker: string;
  readonly blockTime: Date;
}

export interface PositionRecord {
  readonly market: string;
  readonly account: string;
  /** Signed: negative is short. A mirror of contract state, not a balance. */
  readonly size: Amount;
  readonly entryPrice: Amount;
  readonly blockHeight: number;
  readonly blockHash: BlockHash;
}

export interface ApplyOutcome {
  /**
   * True when this block's hash was already recorded canonical.
   *
   * TELEMETRY, NOT CONTROL FLOW. `applyBlock` performs its writes either way,
   * because the guarantee this service needs is that every write is idempotent
   * — not that some caller remembered to check a flag first. A skip branch
   * would mean the idempotent path is the one that never runs in production
   * and therefore the one nothing proves.
   */
  readonly duplicate: boolean;
  readonly eventsApplied: number;
}

export interface UnwindOutcome {
  readonly blocksOrphaned: number;
  readonly bookLevelsRemoved: number;
  readonly fillsRemoved: number;
  readonly positionsRemoved: number;
}

export interface ProjectionStore {
  readonly chainId: number;

  // ── Chain of record ─────────────────────────────────────────────────────

  /** Highest canonical block, or `null` on an empty index. */
  head(): Promise<StoredBlock | null>;

  /** The canonical block at a height, if one is recorded. Never an orphan. */
  blockAt(height: number): Promise<StoredBlock | null>;

  /** Lowest canonical height still recorded — the floor `prune` has left. */
  earliestHeight(): Promise<number | null>;

  // ── Projection ──────────────────────────────────────────────────────────

  /**
   * Journal the block and project every one of its events, ATOMICALLY.
   *
   * Both, or neither. A crash between the two would leave a projection that
   * disagrees with the cursor claiming to describe it, and nothing anywhere
   * records that it was ever half-applied — so it can never be detected, only
   * served.
   *
   * A block whose hash is already recorded as orphaned is restored to
   * canonical. That is not an edge case: a chain that reorgs away from a branch
   * and back to it again is ordinary, and a projection that could not follow it
   * home would be stuck serving the loser.
   */
  applyBlock(block: ChainBlock): Promise<ApplyOutcome>;

  /**
   * Orphan every canonical block at or above `height` and delete what they
   * wrote. Atomic, for the same reason.
   *
   * Block rows are kept (marked `orphaned`) rather than deleted: a projection
   * that silently forgets it ever served a price cannot afterwards explain what
   * a user saw, and the explorer lists a reorged block with its badge.
   */
  unwindTo(height: number): Promise<UnwindOutcome>;

  /**
   * Collapse superseded versions at or below `throughHeight`, keeping the
   * newest version of every key. Orphaned block records are not pruned: unwind
   * already deleted what they wrote, and the explorer keeps showing them.
   *
   * `throughHeight` is the finality horizon: below it we accept we will not be
   * unwinding, so the history that only existed to make an unwind possible has
   * no further job. Returns rows removed.
   */
  prune(throughHeight: number): Promise<number>;

  // ── Reads ───────────────────────────────────────────────────────────────

  /**
   * The book. With no `atHeight` it is the canonical head's book. With
   * `atHeight` it is the book AS OF that canonical block: only versions written
   * at or below it count, and `asOfHeight` / `asOfHash` name that block, not the
   * head. Nothing above `atHeight` can leak in, so a reorg above it leaves the
   * answer unchanged — this is how a caller reads the finalized book.
   *
   * `atHeight` with no canonical block recorded there (above the head, or below
   * what the index ever held) is an empty book with a `null` as-of. Unknown is
   * not a quiet market, and the nearest block is not the one asked for.
   *
   * Exact only while `prune` has not passed `atHeight`: the horizon is the
   * finalized height, so a read at the finalized height is always inside it.
   */
  book(market: string, depth: number, atHeight?: number): Promise<BookView>;

  /**
   * The book as of the finalized block, read as ONE consistent snapshot: the
   * head, the canonical block at `finalizedHeightOf(head, finalityDepth)` and
   * the levels at it all come from the same point in time.
   *
   * This is a method of its own, not `head()` followed by `book(…, atHeight)`,
   * because `prune` runs through `head − finalityDepth` after every sync pass.
   * A prune that lands between those two reads collapses versions at or below
   * a horizon that has moved past the height already chosen, and the book at
   * that older height silently loses levels that are still live — a missing
   * level, with a valid as-of, that a quote reader accepts. Reading everything
   * in one snapshot makes the horizon and the height agree by construction.
   *
   * Empty index, or no canonical block at the finalized height: the empty book
   * with a `null` as-of, as for `book`.
   */
  bookFinalized(market: string, depth: number, finalityDepth: number): Promise<BookView>;
  recentFills(market: string, limit: number): Promise<readonly FillRecord[]>;
  fillsForAccount(account: string, limit: number): Promise<readonly FillRecord[]>;
  position(market: string, account: string): Promise<PositionRecord | null>;
  positionsOf(account: string, limit: number): Promise<readonly PositionRecord[]>;

  /** Distinct markets with any projected state, newest-name order, capped. */
  markets(limit: number): Promise<readonly string[]>;
}
