import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  amountOf,
  assertValidBlock,
  nonNegativeAmountOf,
  positiveAmountOf,
  type BookSide,
  type ChainBlock,
  type ChainTx,
  type ChainTxLog,
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
import type { ExplorerBlockFact } from '../explorer/blocks.js';
import type { ExplorerTxCursor, ExplorerTxListFact, IndexedExplorerTx } from '../explorer/tx.js';

interface ExplorerFactRow {
  height: string;
  hash: string;
  gas_consumed: string;
  gas_limit: string;
  base_fee_per_gas: string | null;
  miner: string;
  tx_count: number;
  size: number;
  block_time: Date;
  status: string;
}
const EXPLORER_COLS =
  'b.height, b.hash, f.gas_consumed::text AS gas_consumed, f.gas_limit::text AS gas_limit, f.base_fee_per_gas::text AS base_fee_per_gas, f.miner, f.tx_count, f.size, b.block_time, b.status';
const EXPLORER_FROM = 'FROM explorer_block_facts f JOIN blocks b ON b.chain_id = f.chain_id AND b.hash = f.hash';

/**
 * Postgres-backed `ProjectionStore`.
 *
 * Table names are UNQUALIFIED on purpose. `createDb` sets `search_path` to the
 * service's own schema (§2 — a service sees only its own tables, enforced by
 * the role's grants), and the test harness sets it to a throwaway schema built
 * from these same migrations. Qualifying them would make the production SQL
 * untestable in isolation, which is how a schema and the code that reads it
 * drift apart.
 *
 * Numeric columns come back from `postgres` as decimal strings and `bigint`
 * columns as strings too. Both are converted at the edge of this file: money
 * through `parseAmount` into scaled bigint, heights through `Number` (a block
 * height is a small integer and stays one). Nothing downstream ever sees a
 * numeric that has been through a float.
 */
export class PostgresProjectionStore implements ProjectionStore {
  constructor(
    private readonly sql: Sql,
    readonly chainId: number,
  ) {}

  // ── Chain of record ───────────────────────────────────────────────────────

  async head(): Promise<StoredBlock | null> {
    const [row] = await this.sql<BlockRow[]>`
      SELECT chain_id, hash, parent_hash, height, status, block_time, event_count
      FROM blocks
      WHERE chain_id = ${this.chainId} AND status = 'canonical'
      ORDER BY height DESC
      LIMIT 1
    `;
    return row ? toStoredBlock(row) : null;
  }

  async blockAt(height: number): Promise<StoredBlock | null> {
    const [row] = await this.sql<BlockRow[]>`
      SELECT chain_id, hash, parent_hash, height, status, block_time, event_count
      FROM blocks
      WHERE chain_id = ${this.chainId} AND height = ${height} AND status = 'canonical'
    `;
    return row ? toStoredBlock(row) : null;
  }

  async earliestHeight(): Promise<number | null> {
    const [row] = await this.sql<Array<{ min: string | null }>>`
      SELECT MIN(height) AS min FROM blocks WHERE chain_id = ${this.chainId} AND status = 'canonical'
    `;
    return row?.min == null ? null : Number(row.min);
  }

  // ── Projection ────────────────────────────────────────────────────────────

  // ── Explorer (D-explorer-01) ─────────────────────────────────────────────

  /** WHERE height < cursor ORDER BY height DESC LIMIT limit + 1 (canonical first). */
  async explorerBlocks(q: { cursor?: number; limit: number }): Promise<ExplorerBlockFact[]> {
    const rows = await this.sql<ExplorerFactRow[]>`
      SELECT ${this.sql.unsafe(EXPLORER_COLS)} ${this.sql.unsafe(EXPLORER_FROM)}
      WHERE f.chain_id = ${this.chainId} ${q.cursor === undefined ? this.sql`` : this.sql`AND b.height < ${q.cursor}`}
      ORDER BY b.height DESC, (b.status = 'orphaned') ASC, b.hash ASC
      LIMIT ${q.limit + 1}
    `;
    return rows.map((r) => this.#fact(r));
  }

  /** Every row at one height, canonical first. */
  async explorerAtHeight(height: number): Promise<ExplorerBlockFact[]> {
    const rows = await this.sql<ExplorerFactRow[]>`
      SELECT ${this.sql.unsafe(EXPLORER_COLS)} ${this.sql.unsafe(EXPLORER_FROM)}
      WHERE f.chain_id = ${this.chainId} AND b.height = ${height}
      ORDER BY (b.status = 'orphaned') ASC, b.hash ASC
    `;
    return rows.map((r) => this.#fact(r));
  }

  /** By hash, or by height (canonical first). null when not stored. */
  async explorerBlock(q: { height: number } | { hash: string }): Promise<ExplorerBlockFact | null> {
    const where = 'hash' in q ? this.sql`AND b.hash = ${q.hash}` : this.sql`AND b.height = ${q.height}`;
    const [row] = await this.sql<ExplorerFactRow[]>`
      SELECT ${this.sql.unsafe(EXPLORER_COLS)} ${this.sql.unsafe(EXPLORER_FROM)}
      WHERE f.chain_id = ${this.chainId} ${where}
      ORDER BY (b.status = 'orphaned') ASC
      LIMIT 1
    `;
    return row ? this.#fact(row) : null;
  }

  /** Newest transactions first, optionally of one block. Orphaned blocks' rows stay, flagged. */
  async explorerTxList(q: { cursor?: ExplorerTxCursor; blockHash?: string; limit: number }): Promise<ExplorerTxListFact[]> {
    const rows = await this.sql<ExplorerTxListRow[]>`
      SELECT t.hash, b.height, b.hash AS block_hash, t.tx_index, t.from_address, t.to_address,
             t.value_wei::text AS value_wei, t.receipt_status, b.block_time, b.status AS block_status
      FROM explorer_txs t
      JOIN blocks b ON b.chain_id = t.chain_id AND b.hash = t.block_hash
      WHERE t.chain_id = ${this.chainId}
        ${q.blockHash === undefined ? this.sql`` : this.sql`AND b.hash = ${q.blockHash.toLowerCase()}`}
        ${q.cursor === undefined ? this.sql`` : this.sql`AND (b.height, t.tx_index, t.hash) < (${q.cursor.height}, ${q.cursor.index}, ${q.cursor.hash})`}
      ORDER BY b.height DESC, t.tx_index DESC, t.hash DESC
      LIMIT ${q.limit + 1}
    `;
    return rows.map((r) => {
      if (r.receipt_status !== 'success' && r.receipt_status !== 'failed') {
        throw new Error(`indexer.tx_status_unreadable: ${r.hash}`);
      }
      return {
        hash: r.hash,
        blockHeight: Number(r.height),
        blockHash: r.block_hash,
        index: r.tx_index,
        from: r.from_address,
        to: r.to_address,
        valueWei: BigInt(r.value_wei),
        status: r.receipt_status,
        timestamp: Math.floor(new Date(r.block_time).getTime() / 1000),
        orphaned: r.block_status === 'orphaned' ? { reason: 'reorg' } : null,
      };
    });
  }

  /** D-explorer-02. Null when this hash was never indexed. Orphans stay visible. */
  async explorerTx(hash: string): Promise<IndexedExplorerTx | null> {
    const id = hash.toLowerCase();
    const [row] = await this.sql<ExplorerTxRow[]>`
      SELECT t.hash, t.tx_index, t.from_address, t.to_address, t.value_wei::text AS value_wei,
             t.nonce, t.gas_limit::text AS gas_limit, t.gas_price_wei::text AS gas_price_wei,
             t.gas_consumed::text AS gas_consumed, t.receipt_status, t.revert_reason, t.input_data,
             t.created_contract, b.status AS block_status
      FROM explorer_txs t
      JOIN blocks b ON b.chain_id = t.chain_id AND b.hash = t.block_hash
      WHERE t.chain_id = ${this.chainId} AND t.hash = ${id}
    `;
    if (!row) return null;
    const logs = await this.sql<ExplorerTxLogRow[]>`
      SELECT log_index, address, topics, data
      FROM explorer_tx_logs
      WHERE chain_id = ${this.chainId} AND tx_hash = ${id}
      ORDER BY log_index ASC
    `;
    let replacementHash: string | null = null;
    if (row.block_status === 'orphaned') {
      const [replacement] = await this.sql<Array<{ hash: string }>>`
        SELECT t2.hash
        FROM explorer_txs t2
        JOIN blocks b2 ON b2.chain_id = t2.chain_id AND b2.hash = t2.block_hash
        WHERE t2.chain_id = ${this.chainId}
          AND t2.from_address = ${row.from_address}
          AND t2.nonce = ${row.nonce}
          AND t2.hash <> ${id}
          AND b2.status = 'canonical'
        ORDER BY b2.height DESC
        LIMIT 1
      `;
      replacementHash = replacement?.hash ?? null;
    }
    const orphaned = row.block_status === 'orphaned';
    return {
      tx: txFromRow(row, logs),
      blockStatus: orphaned ? 'orphaned' : 'canonical',
      replacementHash,
      orphaned: orphaned ? { reason: 'reorg' } : null,
    };
  }

  /** First mempool sight. A repeat keeps the original time. */
  async noteExplorerTxPending(hash: string, at: Date): Promise<void> {
    const seen = at.toISOString();
    await this.sql`
      INSERT INTO explorer_tx_seen (chain_id, hash, first_seen_at)
      VALUES (${this.chainId}, ${hash.toLowerCase()}, ${seen})
      ON CONFLICT (chain_id, hash) DO NOTHING
    `;
  }

  async explorerTxPendingSince(hash: string): Promise<Date | null> {
    const [row] = await this.sql<Array<{ first_seen_at: Date | string }>>`
      SELECT first_seen_at FROM explorer_tx_seen
      WHERE chain_id = ${this.chainId} AND hash = ${hash.toLowerCase()}
    `;
    if (!row) return null;
    const at = row.first_seen_at instanceof Date ? row.first_seen_at : new Date(row.first_seen_at);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  #fact(r: ExplorerFactRow): ExplorerBlockFact {
    return {
      chainId: this.chainId,
      height: Number(r.height),
      hash: r.hash,
      gasUsed: BigInt(r.gas_consumed),
      gasLimit: BigInt(r.gas_limit),
      baseFeePerGas: r.base_fee_per_gas === null ? null : BigInt(r.base_fee_per_gas),
      miner: r.miner,
      txCount: r.tx_count,
      size: r.size,
      timestamp: Math.floor(new Date(r.block_time).getTime() / 1000),
      // LEFT: the real orphan reason is not stored yet (see PR "Still left").
      orphaned: r.status === 'orphaned' ? { reason: 'reorg' } : null,
    };
  }

  /**
   * One transaction for the block record and every event it carries.
   *
   * Read-committed plus a transaction-scoped lock for this schema and chain.
   * The normal ingest loop is one writer; the lock also serializes competing
   * writers and reorg repairs so identity checks see the preceding commit.
   */
  async applyBlock(block: ChainBlock): Promise<ApplyOutcome> {
    assertValidBlock(block);

    if (block.chainId !== this.chainId) {
      throw new Error(`indexer.wrong_chain: block chainId ${block.chainId} does not match store chainId ${this.chainId}`);
    }

    return this.sql.begin(async (tx) => {
      // Serialize identity checks and writes with other applies/reorg repairs.
      // A concurrent first insert of this hash must become visible before we
      // decide that it has no recorded height or parent.
      await tx`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':indexer.projection:' || ${String(this.chainId)})::bigint)`;
      const [prior] = await tx<Array<{ status: string; height: string; parent_hash: string }>>`
        SELECT status, height, parent_hash FROM blocks WHERE chain_id = ${this.chainId} AND hash = ${block.hash}
      `;
      const duplicate = prior?.status === 'canonical';

      // A hash already stored is that block. ON CONFLICT (chain_id, hash)
      // updates status and event_count and leaves height and parent_hash
      // where they were, so the partial unique index on canonical height
      // never sees a second row. The event writes below would still land at
      // the caller-supplied height — including at the current head, and at
      // head+1 when parentHash is the head — and book() / the tape would
      // serve them. Replay at the stored height and parent stays on the
      // idempotent path below.
      if (prior && (Number(prior.height) !== block.height || prior.parent_hash !== block.parentHash)) {
        throw new Error(
          `indexer.block_hash_relocated: hash ${block.hash} is stored at height ${Number(prior.height)} parent ${prior.parent_hash} and cannot be applied at height ${block.height} parent ${block.parentHash}`,
        );
      }

      // Drizzle's postgres-js driver replaces the timestamptz serializer with a
      // pass-through, so binding a Date dies in Buffer.byteLength and ingest
      // never records a height. postgres.js itself writes toISOString(); that
      // is the text a timestamptz column already stores.
      const blockTime = blockTimeForWrite(block.timestamp);

      // Parent link is the store's last line of defence (parity with memory-store).
      // The indexer checks the forward link; a second writer (or a corrupted apply)
      // must not plant a height that does not hang off the current canonical head.
      const [headRow] = await tx<BlockRow[]>`
        SELECT chain_id, hash, parent_hash, height, status, block_time, event_count
        FROM blocks
        WHERE chain_id = ${this.chainId} AND status = 'canonical'
        ORDER BY height DESC
        LIMIT 1
      `;
      const head = headRow ? toStoredBlock(headRow) : null;
      // Under-tip plant (incl. height 0 while head is higher): poisons the tape.
      // Idempotent re-apply of a known hash at that height is fine (duplicate path).
      if (head && block.height < head.height) {
        const [occupantRow] = await tx<Array<{ hash: string }>>`
          SELECT hash FROM blocks
          WHERE chain_id = ${this.chainId} AND height = ${block.height} AND status = 'canonical'
          LIMIT 1
        `;
        if (!occupantRow) {
          throw new Error(
            `indexer.height_below_tip: cannot apply height ${block.height} when canonical head is ${head.height} — unwind first if reorg, do not plant under tip`,
          );
        }
        if (occupantRow.hash !== block.hash) {
          throw new Error(
            `indexer.competing_canonical_block: height ${block.height} already holds canonical ${occupantRow.hash} — unwind first`,
          );
        }
      }
      if (block.height > 0) {
        const [parentRow] = await tx<Array<{ hash: string }>>`
          SELECT hash FROM blocks
          WHERE chain_id = ${this.chainId} AND hash = ${block.parentHash}
          LIMIT 1
        `;
        const parentPresent = Boolean(parentRow);
        if (head && head.height === block.height - 1 && head.hash !== block.parentHash) {
          throw new Error(
            `indexer.parent_mismatch: block ${block.height} claims parent ${block.parentHash} but canonical head is ${head.hash}`,
          );
        }
        if (head && block.height > head.height + 1) {
          throw new Error(
            `indexer.height_gap: cannot apply height ${block.height} when canonical head is ${head.height} — fill or re-index, do not jump`,
          );
        }
        // Empty store may start at any height (startHeight); only enforce parent
        // presence when we already hold the parent height.
        if (head && block.height === head.height + 1 && !parentPresent) {
          throw new Error(`indexer.parent_missing: block ${block.height} parents ${block.parentHash} which is not in the store`);
        }
      }

      // A block whose hash we already orphaned comes back canonical here — a
      // chain that reorgs away and then back is ordinary, and a projection that
      // could not follow it home would be stuck serving the loser.
      //
      // The partial unique index on (chain_id, height) WHERE canonical means
      // this INSERT is what refuses a second canonical block at one height. The
      // database holds that invariant, not this code path.
      await tx`
        INSERT INTO blocks (chain_id, hash, parent_hash, height, status, block_time, event_count)
        VALUES (${this.chainId}, ${block.hash}, ${block.parentHash}, ${block.height}, 'canonical', ${blockTime}, ${block.events.length})
        ON CONFLICT (chain_id, hash) DO UPDATE
          SET status = 'canonical', event_count = EXCLUDED.event_count
      `;

      // D-explorer-01: header facts in the SAME transaction, so a block is
      // never stored with half its facts.
      if (block.header) {
        const h = block.header;
        await tx`
          INSERT INTO explorer_block_facts (chain_id, hash, gas_consumed, gas_limit, base_fee_per_gas, miner, tx_count, size)
          VALUES (${this.chainId}, ${block.hash}, ${h.gasUsed.toString()}, ${h.gasLimit.toString()},
                  ${h.baseFeePerGas === null ? null : h.baseFeePerGas.toString()}, ${h.miner}, ${h.txCount}, ${h.size})
          ON CONFLICT (chain_id, hash) DO NOTHING
        `;
      }

      await writeExplorerTxs(tx, this.chainId, block);

      for (const event of block.events) {
        switch (event.kind) {
          case 'book_level': {
            const price = formatAmount(positiveAmountOf(event.price, 'book level price'));
            const quantity = formatAmount(nonNegativeAmountOf(event.quantity, 'book level quantity'));
            // ABSOLUTE quantity, so the conflict update is an assignment rather
            // than an accumulation. That is what makes re-processing a block a
            // no-op instead of a double count.
            await tx`
              INSERT INTO book_levels (chain_id, market, side, price, block_height, block_hash, quantity)
              VALUES (${this.chainId}, ${event.market}, ${event.side}, ${price}, ${block.height}, ${block.hash}, ${quantity})
              ON CONFLICT (chain_id, market, side, price, block_height) DO UPDATE
                SET quantity = EXCLUDED.quantity, block_hash = EXCLUDED.block_hash
            `;
            break;
          }

          case 'fill': {
            // (block hash, log index) is the chain's own identity for a log.
            // DO NOTHING here is THE anti-double-count guarantee for the tape:
            // a re-read of the same block inserts nothing at all.
            // Addresses lowercased on write so EIP-55 spellings cannot dual-key
            // against case-sensitive DISTINCT ON / unique indexes.
            const maker = event.maker.toLowerCase();
            const taker = event.taker.toLowerCase();
            await tx`
              INSERT INTO fills (chain_id, block_hash, log_index, block_height, market, price, quantity, taker_side, maker, taker, block_time)
              VALUES (
                ${this.chainId}, ${block.hash}, ${event.logIndex}, ${block.height}, ${event.market},
                ${formatAmount(positiveAmountOf(event.price, 'fill price'))},
                ${formatAmount(positiveAmountOf(event.quantity, 'fill quantity'))},
                ${event.takerSide}, ${maker}, ${taker}, ${blockTime}
              )
              ON CONFLICT (chain_id, block_hash, log_index) DO NOTHING
            `;
            break;
          }

          case 'position': {
            const account = event.account.toLowerCase();
            await tx`
              INSERT INTO positions (chain_id, market, account, block_height, block_hash, size, entry_price)
              VALUES (
                ${this.chainId}, ${event.market}, ${account}, ${block.height}, ${block.hash},
                ${formatAmount(amountOf(event.size, 'position size'))},
                ${formatAmount(nonNegativeAmountOf(event.entryPrice, 'position entry price'))}
              )
              ON CONFLICT (chain_id, market, account, block_height) DO UPDATE
                SET size = EXCLUDED.size, entry_price = EXCLUDED.entry_price, block_hash = EXCLUDED.block_hash
            `;
            break;
          }
        }
      }

      return { duplicate, eventsApplied: block.events.length };
    }) as Promise<ApplyOutcome>;
  }

  async unwindTo(height: number): Promise<UnwindOutcome> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':indexer.projection:' || ${String(this.chainId)})::bigint)`;
      const orphaned = await tx`
        UPDATE blocks SET status = 'orphaned'
        WHERE chain_id = ${this.chainId} AND height >= ${height} AND status = 'canonical'
      `;
      const levels = await tx`DELETE FROM book_levels WHERE chain_id = ${this.chainId} AND block_height >= ${height}`;
      const fills = await tx`DELETE FROM fills WHERE chain_id = ${this.chainId} AND block_height >= ${height}`;
      const positions = await tx`DELETE FROM positions WHERE chain_id = ${this.chainId} AND block_height >= ${height}`;

      return {
        blocksOrphaned: orphaned.count,
        bookLevelsRemoved: levels.count,
        fillsRemoved: fills.count,
        positionsRemoved: positions.count,
      };
    }) as Promise<UnwindOutcome>;
  }

  async prune(throughHeight: number): Promise<number> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':indexer.projection:' || ${String(this.chainId)})::bigint)`;
      // "Delete a version that a newer version at or below the horizon already
      // supersedes." The `<= throughHeight` on the inner query matters: without
      // it, a level written above the horizon would let this delete the last
      // version below it, and an unwind back past the horizon would then find
      // nothing to fall back to.
      const levels = await tx`
        DELETE FROM book_levels bl
        WHERE bl.chain_id = ${this.chainId}
          AND bl.block_height <= ${throughHeight}
          AND EXISTS (
            SELECT 1 FROM book_levels n
            WHERE n.chain_id = bl.chain_id AND n.market = bl.market AND n.side = bl.side
              AND n.price = bl.price
              AND n.block_height > bl.block_height AND n.block_height <= ${throughHeight}
          )
      `;

      const positions = await tx`
        DELETE FROM positions p
        WHERE p.chain_id = ${this.chainId}
          AND p.block_height <= ${throughHeight}
          AND EXISTS (
            SELECT 1 FROM positions n
            WHERE n.chain_id = p.chain_id AND n.market = p.market AND n.account = p.account
              AND n.block_height > p.block_height AND n.block_height <= ${throughHeight}
          )
      `;

      const orphans = await tx`
        DELETE FROM blocks
        WHERE chain_id = ${this.chainId} AND status = 'orphaned' AND height <= ${throughHeight}
      `;

      return levels.count + positions.count + orphans.count;
    }) as Promise<number>;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async book(market: string, depth: number, atHeight?: number): Promise<BookView> {
    // Pinned read: the as-of block must be a canonical block we hold. Without
    // one there is nothing to name, so the book is empty with a null as-of.
    return this.#bookSnapshot(market, depth, (head) => (atHeight === undefined ? (head?.height ?? null) : atHeight));
  }

  async bookFinalized(market: string, depth: number, finalityDepth: number): Promise<BookView> {
    return this.#bookSnapshot(market, depth, (head) => finalizedHeightOf(head, finalityDepth));
  }

  /**
   * Head, as-of block and both sides in ONE snapshot. REPEATABLE READ pins every
   * statement to the same point in time, so a `prune` (or an apply, or an
   * unwind) committing mid-read is invisible to the whole read rather than
   * visible to half of it. READ ONLY because this path must never write.
   */
  async #bookSnapshot(market: string, depth: number, pick: (head: StoredBlock | null) => number | null): Promise<BookView> {
    return this.sql.begin('isolation level repeatable read read only', async (tx) => {
      const [headRow] = await tx<BlockRow[]>`
        SELECT chain_id, hash, parent_hash, height, status, block_time, event_count
        FROM blocks
        WHERE chain_id = ${this.chainId} AND status = 'canonical'
        ORDER BY height DESC
        LIMIT 1
      `;
      const head = headRow ? toStoredBlock(headRow) : null;
      const height = pick(head);
      let asOf: StoredBlock | null = null;
      if (height !== null) {
        if (head && head.height === height) {
          asOf = head;
        } else {
          const [row] = await tx<BlockRow[]>`
            SELECT chain_id, hash, parent_hash, height, status, block_time, event_count
            FROM blocks
            WHERE chain_id = ${this.chainId} AND height = ${height} AND status = 'canonical'
          `;
          asOf = row ? toStoredBlock(row) : null;
        }
      }
      if (!asOf) {
        return { market, chainId: this.chainId, asOfHeight: null, asOfHash: null, bids: [], asks: [] } satisfies BookView;
      }
      const bids = await this.#side(tx, market, 'bid', depth, asOf.height);
      const asks = await this.#side(tx, market, 'ask', depth, asOf.height);
      return { market, chainId: this.chainId, asOfHeight: asOf.height, asOfHash: asOf.hash, bids, asks } satisfies BookView;
    }) as Promise<BookView>;
  }

  /**
   * One side of the book: newest version per price, empty levels dropped.
   *
   * The `quantity > 0` filter sits OUTSIDE the `DISTINCT ON`, and that ordering
   * is the whole correctness of the query. Inside, it would skip the version
   * that emptied a level and fall back to the depth that level had in an
   * earlier block — resurrecting liquidity that is gone.
   */
  async #side(q: TransactionSql, market: string, side: BookSide, depth: number, atHeight: number): Promise<BookLevel[]> {
    const rows =
      side === 'bid'
        ? await q<LevelRow[]>`
            SELECT price, quantity FROM (
              SELECT DISTINCT ON (price) price, quantity
              FROM book_levels
              WHERE chain_id = ${this.chainId} AND market = ${market} AND side = 'bid' AND block_height <= ${atHeight}
              ORDER BY price, block_height DESC
            ) current
            WHERE quantity > 0
            ORDER BY price DESC
            LIMIT ${depth}
          `
        : await q<LevelRow[]>`
            SELECT price, quantity FROM (
              SELECT DISTINCT ON (price) price, quantity
              FROM book_levels
              WHERE chain_id = ${this.chainId} AND market = ${market} AND side = 'ask' AND block_height <= ${atHeight}
              ORDER BY price, block_height DESC
            ) current
            WHERE quantity > 0
            ORDER BY price ASC
            LIMIT ${depth}
          `;

    return rows.map((row) => ({ price: parseAmount(row.price), quantity: parseAmount(row.quantity) }));
  }

  async recentFills(market: string, limit: number): Promise<readonly FillRecord[]> {
    const rows = await this.sql<FillRow[]>`
      SELECT f.block_height, f.block_hash, f.log_index, f.market, f.price, f.quantity, f.taker_side, f.maker, f.taker, f.block_time
      FROM fills f
      INNER JOIN blocks b
        ON b.chain_id = f.chain_id AND b.hash = f.block_hash AND b.status = 'canonical'
      WHERE f.chain_id = ${this.chainId} AND f.market = ${market}
      ORDER BY f.block_height DESC, f.log_index DESC
      LIMIT ${limit}
    `;
    return rows.map(toFill);
  }

  async fillsForAccount(account: string, limit: number): Promise<readonly FillRecord[]> {
    const rows = await this.sql<FillRow[]>`
      SELECT f.block_height, f.block_hash, f.log_index, f.market, f.price, f.quantity, f.taker_side, f.maker, f.taker, f.block_time
      FROM fills f
      INNER JOIN blocks b
        ON b.chain_id = f.chain_id AND b.hash = f.block_hash AND b.status = 'canonical'
      WHERE f.chain_id = ${this.chainId} AND (lower(f.maker) = lower(${account}) OR lower(f.taker) = lower(${account}))
      ORDER BY f.block_height DESC, f.log_index DESC
      LIMIT ${limit}
    `;
    return rows.map(toFill);
  }

  async position(market: string, account: string): Promise<PositionRecord | null> {
    const [row] = await this.sql<PositionRow[]>`
      SELECT DISTINCT ON (market, account) market, account, size, entry_price, block_height, block_hash
      FROM positions
      WHERE chain_id = ${this.chainId} AND market = ${market} AND lower(account) = lower(${account})
      ORDER BY market, account, block_height DESC
    `;
    return row ? toPosition(row) : null;
  }

  async positionsOf(account: string, limit: number): Promise<readonly PositionRecord[]> {
    const rows = await this.sql<PositionRow[]>`
      SELECT DISTINCT ON (market, account) market, account, size, entry_price, block_height, block_hash
      FROM positions
      WHERE chain_id = ${this.chainId} AND lower(account) = lower(${account})
      ORDER BY market, account, block_height DESC
      LIMIT ${limit}
    `;
    return rows.map(toPosition);
  }

  async markets(limit: number): Promise<readonly string[]> {
    const rows = await this.sql<Array<{ market: string }>>`
      SELECT market FROM book_levels WHERE chain_id = ${this.chainId}
      UNION
      SELECT market FROM fills WHERE chain_id = ${this.chainId}
      UNION
      SELECT market FROM positions WHERE chain_id = ${this.chainId}
      ORDER BY market
      LIMIT ${limit}
    `;
    return rows.map((r) => r.market);
  }
}

// ── Row shapes and conversions ──────────────────────────────────────────────

interface BlockRow {
  chain_id: number;
  hash: string;
  parent_hash: string;
  height: string;
  status: string;
  block_time: Date | string;
  event_count: number;
}

interface LevelRow {
  price: string;
  quantity: string;
}

interface FillRow {
  block_height: string;
  block_hash: string;
  log_index: number;
  market: string;
  price: string;
  quantity: string;
  taker_side: string;
  maker: string;
  taker: string;
  block_time: Date | string;
}

interface PositionRow {
  market: string;
  account: string;
  size: string;
  entry_price: string;
  block_height: string;
  block_hash: string;
}

function toStoredBlock(row: BlockRow): StoredBlock {
  return {
    chainId: row.chain_id,
    height: Number(row.height),
    hash: row.hash,
    parentHash: row.parent_hash,
    status: row.status === 'orphaned' ? 'orphaned' : 'canonical',
    blockTime: blockTimeFromRow(row.block_time),
    eventCount: row.event_count,
  };
}

function toFill(row: FillRow): FillRecord {
  return {
    blockHeight: Number(row.block_height),
    blockHash: row.block_hash,
    logIndex: row.log_index,
    market: row.market,
    price: parseAmount(row.price),
    quantity: parseAmount(row.quantity),
    takerSide: row.taker_side as TakerSide,
    maker: row.maker,
    taker: row.taker,
    blockTime: blockTimeFromRow(row.block_time),
  };
}

/** Unix seconds from the block, as the ISO string postgres.js would have sent. */
function blockTimeForWrite(timestampSeconds: number): string {
  const at = new Date(timestampSeconds * 1000);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`indexer.block_time_unreadable: unix seconds ${timestampSeconds}`);
  }
  return at.toISOString();
}

/**
 * The production client returns timestamptz as text (Drizzle's parser is a
 * pass-through). The conformance client returns a Date. Callers see a Date.
 */
function blockTimeFromRow(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('indexer.block_time_unreadable');
    return value;
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`indexer.block_time_unreadable: ${value}`);
  return at;
}

function toPosition(row: PositionRow): PositionRecord {
  return {
    market: row.market,
    account: row.account,
    size: parseAmount(row.size) as Amount,
    entryPrice: parseAmount(row.entry_price),
    blockHeight: Number(row.block_height),
    blockHash: row.block_hash,
  };
}

interface ExplorerTxRow {
  hash: string;
  tx_index: number;
  from_address: string;
  to_address: string | null;
  value_wei: string;
  nonce: number;
  gas_limit: string;
  gas_price_wei: string | null;
  gas_consumed: string | null;
  receipt_status: string;
  revert_reason: string | null;
  input_data: string;
  created_contract: string | null;
  block_status: string;
}

interface ExplorerTxListRow {
  hash: string;
  height: string;
  block_hash: string;
  tx_index: number;
  from_address: string;
  to_address: string | null;
  value_wei: string;
  receipt_status: string;
  block_time: Date;
  block_status: string;
}

interface ExplorerTxLogRow {
  log_index: number;
  address: string;
  topics: string;
  data: string;
}

function weiColumn(value: string | null): bigint | null {
  if (value === null) return null;
  return BigInt(value);
}

function txFromRow(row: ExplorerTxRow, logs: readonly ExplorerTxLogRow[]): ChainTx {
  if (row.receipt_status !== 'success' && row.receipt_status !== 'failed') {
    throw new Error(`indexer.tx_status_unreadable: ${row.hash}`);
  }
  const parsedLogs: ChainTxLog[] = logs.map((log) => {
    const topics = JSON.parse(log.topics) as unknown;
    if (!Array.isArray(topics) || topics.some((topic) => typeof topic !== 'string')) {
      throw new Error(`indexer.tx_log_unreadable: ${row.hash}`);
    }
    return { logIndex: log.log_index, address: log.address, topics, data: log.data };
  });
  return {
    hash: row.hash,
    index: row.tx_index,
    from: row.from_address,
    to: row.to_address,
    valueWei: BigInt(row.value_wei),
    nonce: row.nonce,
    gasLimit: BigInt(row.gas_limit),
    gasPriceWei: weiColumn(row.gas_price_wei),
    gasConsumed: weiColumn(row.gas_consumed),
    status: row.receipt_status,
    revertReason: row.revert_reason,
    input: row.input_data,
    createdContract: row.created_contract,
    logs: parsedLogs,
  };
}

/**
 * Replace this block's transaction rows. Absent `transactions` leaves them alone.
 *
 * Unwind only marks the block orphaned, so a hash this block re-includes still
 * sits on the orphan. Delete that row here, before insert, or the primary key
 * rolls the winning block back. A hash this block does not carry stays on the
 * orphan, and its logs stay with it. Logs of a deleted row cascade.
 */
async function writeExplorerTxs(sql: TransactionSql, chainId: number, block: ChainBlock): Promise<void> {
  if (!block.transactions) return;
  const hashes = block.transactions.map((row) => row.hash.toLowerCase());
  await sql`
    DELETE FROM explorer_txs
    WHERE chain_id = ${chainId}
      AND (
        block_hash = ${block.hash}
        ${hashes.length > 0 ? sql`OR hash = ANY(${sql.array(hashes)}::text[])` : sql``}
      )
  `;
  for (const row of block.transactions) {
    await sql`
      INSERT INTO explorer_txs (
        chain_id, hash, block_hash, tx_index, from_address, to_address, value_wei, nonce,
        gas_limit, gas_price_wei, gas_consumed, receipt_status, revert_reason, input_data, created_contract
      ) VALUES (
        ${chainId}, ${row.hash.toLowerCase()}, ${block.hash}, ${row.index}, ${row.from.toLowerCase()},
        ${row.to === null ? null : row.to.toLowerCase()}, ${row.valueWei.toString()}, ${row.nonce},
        ${row.gasLimit.toString()}, ${row.gasPriceWei === null ? null : row.gasPriceWei.toString()},
        ${row.gasConsumed === null ? null : row.gasConsumed.toString()}, ${row.status}, ${row.revertReason},
        ${row.input}, ${row.createdContract === null ? null : row.createdContract.toLowerCase()}
      )
    `;
    for (const log of row.logs) {
      await sql`
        INSERT INTO explorer_tx_logs (chain_id, tx_hash, log_index, address, topics, data)
        VALUES (
          ${chainId}, ${row.hash.toLowerCase()}, ${log.logIndex}, ${log.address.toLowerCase()},
          ${JSON.stringify(log.topics.map((topic) => topic.toLowerCase()))}, ${log.data}
        )
      `;
    }
  }
}
