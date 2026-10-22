import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { formatAmount } from '@intafaced/ledger-client/money';
import { PostgresProjectionStore } from './postgres-store.js';
import { CHAIN_ID, runProjectionConformance } from '../testing/conformance.js';
import type { ChainBlock } from '../chain/source.js';
import { listPage, parseExplorerListLimit } from '../explorer/blocks.js';

/**
 * The Postgres store runs the SAME conformance suite as the in-memory
 * reference. If the two disagree, one of them is wrong and the suite decides.
 *
 * That matters most for the reorg section. `unwindTo` is a DELETE and
 * `prune` is a DELETE with a correlated subquery — the kind of SQL that looks
 * right and is off by one row, and the kind no amount of reading catches. The
 * memory store's version of both is short enough to check by eye, so running
 * them against the same assertions is the check.
 *
 * Isolation: every run gets its own Postgres schema via `createTestDb`, built
 * from this service's real migrations. Two worktrees can run this file at once.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (CREATEDB via `createTestDb`). Local without that env starts
 * Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite, not a
 * green skip. The admin URL is `TEST_DATABASE_URL`, not a per-service role:
 * creating a schema needs CREATEDB, which those roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

/**
 * Every forward migration, in order — read from disk rather than listed here.
 * A hardcoded filename means the test schema silently drifts from the real one
 * the first time someone adds a migration.
 */
const migrationFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();

if (migrationFiles.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const migrations = migrationFiles.map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const downFiles = migrationFiles.map((f) => readFileSync(join(drizzleDir, f.replace(/\.sql$/, '.down.sql')), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-indexer postgres-store is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-indexer postgres-store PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-indexer · PostgresProjectionStore PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDb;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({
      service: 'indexer',
      url: admin.url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'indexer', schema)),
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  runProjectionConformance('PostgresProjectionStore', async () => {
    const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
    return {
      store,
      reset: async () => {
        await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      },
    };
  });

  describe('svc-indexer · database-level guarantees', () => {
    it('serializes competing first writes of one hash before checking its identity', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const first = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const second = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const hash = `0x${'77'.repeat(32)}`;
      const block = { chainId: CHAIN_ID, hash, parentHash: `0x${'00'.repeat(32)}`, height: 0, timestamp: 1_700_000_000, events: [] };
      const results = await Promise.allSettled([first.applyBlock(block), second.applyBlock({ ...block, height: 1 })]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') expect(String(rejected.reason)).toMatch(/block_hash_relocated/);
      const winningHeight = results[0]?.status === 'fulfilled' ? 0 : 1;
      expect(await first.head()).toMatchObject({ hash, height: winningHeight });
      expect(await first.blockAt(1 - winningHeight)).toBeNull();
    });

    /**
     * The invariant the code does not have to be trusted with.
     *
     * Two canonical blocks at one height means two answers to every read below
     * it. A bug that produces one is otherwise invisible until a user sees the
     * wrong price, so the partial unique index makes the state unrepresentable
     * — and this asserts the index exists rather than assuming the migration
     * ran the way it reads.
     */
    it('refuses two canonical blocks at the same height', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const insert = (hash: string) => db.sql`
        INSERT INTO blocks (chain_id, hash, parent_hash, height, status, block_time)
        VALUES (${CHAIN_ID}, ${hash}, ${`0x${'0'.repeat(64)}`}, 7, 'canonical', now())
      `;
      await insert(`0x${'a'.repeat(64)}`);
      await expect(insert(`0x${'b'.repeat(64)}`)).rejects.toMatchObject({ code: '23505' });

      // …but an ORPHANED block may share the height. That is the whole point of
      // keeping the loser: a partial index that also covered orphans would make
      // the forensic record impossible to write.
      await expect(db.sql`
        INSERT INTO blocks (chain_id, hash, parent_hash, height, status, block_time)
        VALUES (${CHAIN_ID}, ${`0x${'c'.repeat(64)}`}, ${`0x${'0'.repeat(64)}`}, 7, 'orphaned', now())
      `).resolves.toBeDefined();
    });

    it('stores money as numeric, not as a float', async () => {
      const [row] = await db.sql<Array<{ data_type: string; numeric_precision: number; numeric_scale: number }>>`
        SELECT data_type, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = 'book_levels' AND column_name = 'quantity'
      `;
      expect(row).toMatchObject({ data_type: 'numeric', numeric_precision: 38, numeric_scale: 18 });
    });

    it('D-explorer-01: limit-1 walk lists canonical and orphan at one height', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const h = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
      const header = { gasUsed: 1n, gasLimit: 2n, baseFeePerGas: 1n, miner: `0x${'cd'.repeat(20)}`, txCount: 0, size: 1 };
      await store.applyBlock({
        chainId: CHAIN_ID,
        height: 0,
        hash: h(0x60),
        parentHash: `0x${'00'.repeat(32)}`,
        timestamp: 1_700_000_000,
        events: [],
        header,
      });
      await store.applyBlock({
        chainId: CHAIN_ID,
        height: 1,
        hash: h(0x61),
        parentHash: h(0x60),
        timestamp: 1_700_000_001,
        events: [],
        header,
      });
      // Orphan the first height-1 block, then the canonical replacement.
      await db.sql`UPDATE blocks SET status = 'orphaned' WHERE chain_id = ${CHAIN_ID} AND hash = ${h(0x61)}`;
      await store.applyBlock({
        chainId: CHAIN_ID,
        height: 1,
        hash: h(0x62),
        parentHash: h(0x60),
        timestamp: 1_700_000_002,
        events: [],
        header,
      });
      const source = {
        listLimit: parseExplorerListLimit('1'),
        blocks: (q: { cursor?: number; limit: number }) => store.explorerBlocks(q),
        atHeight: (n: number) => store.explorerAtHeight(n),
        block: (q: { height: number } | { hash: string }) => store.explorerBlock(q),
      };
      const seen: Array<[number, string, boolean]> = [];
      let cursor: number | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await listPage(source, { cursor, limit: 1 });
        seen.push(...page.rows.map((r): [number, string, boolean] => [r.height, r.hash, r.orphaned !== null]));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual([
        [1, h(0x62), false],
        [1, h(0x61), true],
        [0, h(0x60), false],
      ]);
    });

    it('D-explorer-01: header facts stored with the block; DB paging and lookup; FK holds', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const hash = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
      const header = { gasUsed: 21_000n, gasLimit: 30_000_000n, baseFeePerGas: null, miner: `0x${'ab'.repeat(20)}`, txCount: 1, size: 612 };
      let parent = `0x${'00'.repeat(32)}`;
      for (let h = 0; h < 4; h++) {
        await store.applyBlock({
          chainId: CHAIN_ID,
          height: h,
          hash: hash(0x50 + h),
          parentHash: parent,
          timestamp: 1_700_000_000 + h,
          events: [],
          ...(h === 3 ? {} : { header }),
        });
        parent = hash(0x50 + h);
      }
      // Height 3 has no header: never stored as a partial fact row.
      const first = await store.explorerBlocks({ limit: 2 });
      expect(first.map((f) => f.height)).toEqual([2, 1, 0]);
      expect(first[0]).toEqual({
        chainId: CHAIN_ID,
        height: 2,
        hash: hash(0x52),
        gasUsed: 21_000n,
        gasLimit: 30_000_000n,
        baseFeePerGas: null,
        miner: header.miner,
        txCount: 1,
        size: 612,
        timestamp: 1_700_000_002,
        orphaned: null,
      });
      expect((await store.explorerBlocks({ cursor: 1, limit: 2 })).map((f) => f.height)).toEqual([0]);
      expect((await store.explorerBlock({ height: 1 }))?.hash).toBe(hash(0x51));
      expect((await store.explorerBlock({ hash: hash(0x50) }))?.height).toBe(0);
      expect(await store.explorerBlock({ height: 3 })).toBeNull();
      expect(await store.explorerBlock({ height: 999_999_999 })).toBeNull();
      await expect(
        db.sql`INSERT INTO explorer_block_facts (chain_id, hash, gas_used, gas_limit, miner, tx_count, size) VALUES (${CHAIN_ID}, ${hash(0x99)}, 1, 1, ${header.miner}, 0, 0)`,
      ).rejects.toThrow(/foreign key/);
    });

    /**
     * Parent-link / height-gap parity with MemoryProjectionStore (memory #1420).
     * The store is the last line of defence if a second writer or corrupt apply
     * tries to plant an unlinked height.
     */
    it('refuses parent mismatch and height gaps without moving head', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const H0 = `0x${'11'.repeat(32)}`;
      const H1 = `0x${'22'.repeat(32)}`;
      const H2 = `0x${'33'.repeat(32)}`;
      const BAD = `0x${'44'.repeat(32)}`;
      const blk = (height: number, hash: string, parentHash: string) => ({
        chainId: CHAIN_ID,
        height,
        hash,
        parentHash,
        timestamp: 1_700_000_000 + height,
        events: [] as const,
      });

      await store.applyBlock(blk(0, H0, `0x${'00'.repeat(32)}`));
      await store.applyBlock(blk(1, H1, H0));

      await expect(store.applyBlock(blk(2, H2, BAD))).rejects.toThrow(/parent_mismatch|parent_missing/);
      expect((await store.head())?.hash).toBe(H1);

      await expect(store.applyBlock(blk(3, H2, H1))).rejects.toThrow(/height_gap/);
      expect((await store.head())?.height).toBe(1);

      await store.applyBlock(blk(2, H2, H1));
      expect((await store.head())?.hash).toBe(H2);
    });

    it('refuses planting a height below the current tip', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const H0 = `0x${'11'.repeat(32)}`;
      const H1 = `0x${'22'.repeat(32)}`;
      const H2 = `0x${'33'.repeat(32)}`;
      const blk = (height: number, hash: string, parentHash: string) => ({
        chainId: CHAIN_ID,
        height,
        hash,
        parentHash,
        timestamp: 1_700_000_000 + height,
        events: [] as const,
      });

      // Cold start at height 5 — under-tip empty is normal after startHeight.
      await store.applyBlock(blk(5, H0, `0x${'00'.repeat(32)}`));
      await store.applyBlock(blk(6, H1, H0));

      await expect(store.applyBlock(blk(0, H2, `0x${'00'.repeat(32)}`))).rejects.toThrow(/height_below_tip/);
      expect((await store.head())?.hash).toBe(H1);
      expect(await store.blockAt(0)).toBeNull();
    });

    /**
     * A known hash reapplied at the head, or at head+1 with that head as
     * parent, used to skip the under-tip guards. ON CONFLICT left the stored
     * height in place and the event writes still landed at the caller height.
     * Same-height replay of that hash stays on the idempotent path.
     */
    it('refuses a known hash at another height and writes nothing at the caller height', async () => {
      await db.sql`TRUNCATE positions, fills, book_levels, blocks RESTART IDENTITY CASCADE`;
      const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
      const MARKET = 'IFC-USD';
      const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const GENESIS = `0x${'00'.repeat(32)}`;
      const H0 = `0x${'11'.repeat(32)}`;
      const H1 = `0x${'22'.repeat(32)}`;
      const PRICE = '100';

      const stored: ChainBlock = {
        chainId: CHAIN_ID,
        height: 0,
        hash: H0,
        parentHash: GENESIS,
        timestamp: 1_700_000_000,
        events: [
          { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: PRICE, quantity: '5' },
          {
            kind: 'fill',
            logIndex: 1,
            market: MARKET,
            price: PRICE,
            quantity: '1',
            takerSide: 'buy',
            maker: ALICE,
            taker: BOB,
          },
          { kind: 'position', logIndex: 2, market: MARKET, account: ALICE, size: '2', entryPrice: PRICE },
        ],
      };
      await store.applyBlock(stored);
      await store.applyBlock({
        chainId: CHAIN_ID,
        height: 1,
        hash: H1,
        parentHash: H0,
        timestamp: 1_700_000_001,
        events: [{ kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: PRICE, quantity: '7' }],
      });

      const heightsFor = async (table: 'book_levels' | 'fills' | 'positions') => {
        const rows = await db.sql<Array<{ block_height: string }>>`
          SELECT block_height FROM ${db.sql(table)}
          WHERE chain_id = ${CHAIN_ID} AND block_hash = ${H0}
          ORDER BY block_height
        `;
        return rows.map((row) => Number(row.block_height));
      };

      // Same hash at the current head, parent unchanged. The under-tip guard
      // does not run here. A same-price level would overwrite the tip row.
      await expect(
        store.applyBlock({
          chainId: CHAIN_ID,
          height: 1,
          hash: H0,
          parentHash: GENESIS,
          timestamp: 1_700_000_001,
          events: [
            { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: PRICE, quantity: '1' },
            {
              kind: 'fill',
              logIndex: 3,
              market: MARKET,
              price: PRICE,
              quantity: '1',
              takerSide: 'buy',
              maker: ALICE,
              taker: BOB,
            },
            { kind: 'position', logIndex: 4, market: MARKET, account: ALICE, size: '2', entryPrice: PRICE },
          ],
        }),
      ).rejects.toThrow(/block_hash_relocated/);

      // Same hash at head+1, parent = current head. Parent gates pass; the
      // canonical-height index does not, because the stored row never moves.
      await expect(
        store.applyBlock({
          chainId: CHAIN_ID,
          height: 2,
          hash: H0,
          parentHash: H1,
          timestamp: 1_700_000_002,
          events: [
            { kind: 'book_level', logIndex: 0, market: MARKET, side: 'bid', price: PRICE, quantity: '1' },
            {
              kind: 'fill',
              logIndex: 3,
              market: MARKET,
              price: PRICE,
              quantity: '1',
              takerSide: 'buy',
              maker: ALICE,
              taker: BOB,
            },
            { kind: 'position', logIndex: 4, market: MARKET, account: ALICE, size: '2', entryPrice: PRICE },
          ],
        }),
      ).rejects.toThrow(/block_hash_relocated/);

      expect((await store.head())?.hash).toBe(H1);
      expect((await store.head())?.height).toBe(1);
      expect(await store.blockAt(2)).toBeNull();

      const atZero = await store.blockAt(0);
      expect(atZero?.hash).toBe(H0);
      expect(atZero?.height).toBe(0);
      expect(atZero?.parentHash).toBe(GENESIS);
      expect(atZero?.eventCount).toBe(3);

      const book = await store.book(MARKET, 10);
      expect(book.asOfHeight).toBe(1);
      expect(book.asOfHash).toBe(H1);
      expect(book.bids.map((level) => [formatAmount(level.price), formatAmount(level.quantity)])).toEqual([[PRICE, '7']]);

      const position = await store.position(MARKET, ALICE);
      expect(formatAmount(position!.size)).toBe('2');
      expect(formatAmount(position!.entryPrice)).toBe(PRICE);
      expect(position!.blockHeight).toBe(0);
      expect(position!.blockHash).toBe(H0);

      const fills = await store.recentFills(MARKET, 50);
      expect(fills.map((fill) => [fill.blockHash, fill.blockHeight, fill.logIndex, formatAmount(fill.price)])).toEqual([[H0, 0, 1, PRICE]]);

      expect(await heightsFor('book_levels')).toEqual([0]);
      expect(await heightsFor('fills')).toEqual([0]);
      expect(await heightsFor('positions')).toEqual([0]);

      const [tip] = await db.sql<Array<{ block_hash: string }>>`
        SELECT block_hash FROM book_levels
        WHERE chain_id = ${CHAIN_ID} AND block_height = 1 AND side = 'bid'
      `;
      expect(tip?.block_hash).toBe(H1);

      const replay = await store.applyBlock(stored);
      expect(replay.duplicate).toBe(true);
      expect(formatAmount((await store.book(MARKET, 10)).bids[0]!.quantity)).toBe('7');
      expect(formatAmount((await store.position(MARKET, ALICE))!.size)).toBe('2');
      expect((await store.position(MARKET, ALICE))!.blockHeight).toBe(0);
      expect(await store.recentFills(MARKET, 50)).toHaveLength(1);
      expect((await store.blockAt(0))?.parentHash).toBe(GENESIS);
      expect((await store.blockAt(0))?.eventCount).toBe(3);
      expect(await heightsFor('book_levels')).toEqual([0]);
      expect(await heightsFor('fills')).toEqual([0]);
      expect(await heightsFor('positions')).toEqual([0]);
    });

    /**
     * Reversibility, proven rather than claimed (§14 DoD).
     *
     * Applies every `.down.sql` in reverse, asserts the tables are gone, then
     * re-applies the forward migrations and asserts they are back. A reversal
     * that has never been executed is a file, not a rollback plan.
     */
    it('reverses and re-applies every migration', async () => {
      const tableNames = async () =>
        (
          await db.sql<Array<{ table_name: string }>>`
            SELECT table_name FROM information_schema.tables WHERE table_schema = ${db.schema} ORDER BY table_name
          `
        ).map((r) => r.table_name);

      const before = await tableNames();
      expect(before).toEqual(['blocks', 'book_levels', 'explorer_block_facts', 'fills', 'positions']);

      for (const body of [...downFiles].reverse()) {
        await db.sql.unsafe(rewriteSchemaSql(body, 'indexer', db.schema));
      }
      expect(await tableNames()).toEqual([]);

      for (const body of migrations) {
        await db.sql.unsafe(rewriteSchemaSql(body, 'indexer', db.schema));
      }
      expect(await tableNames()).toEqual(before);
    });
  });
});
