import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgresLedger } from '../ledger/postgres-ledger.js';
import { reconcileBalances, runReconciliation, totalsByAsset, verifyChain } from '../ledger/reconcile.js';

/**
 * 0023 — THE DATABASE REFUSES TO REWRITE POSTED HISTORY, AND REFUSES AN
 * UNBALANCED TRANSACTION AT COMMIT.
 *
 * Raw SQL throughout for the refusals: the point of a database backstop is that
 * it holds when the TypeScript posting path is not the one writing. Normal
 * posting through `PostgresLedger` is exercised alongside, because a guard that
 * also blocks the real writer is worse than no guard.
 *
 * H8a PG-hard: never skip-green. CI uses TEST_DATABASE_URL (per-run schema via
 * `createTestDb`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const UP_FILE = '0023_entries_immutable.sql';
const DOWN_FILE = '0023_entries_immutable.down.sql';

const upFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const toStep = (body: string) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema);
const migrations = upFiles.map((f) => toStep(readFileSync(join(drizzleDir, f), 'utf8')));
const UP = readFileSync(join(drizzleDir, UP_FILE), 'utf8');
const DOWN = readFileSync(join(drizzleDir, DOWN_FILE), 'utf8');

const CHECK_VIOLATION = '23514';
const USER = '9a3b6f0e-1d2c-4e5f-8a7b-0c1d2e3f4a5b';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-ledger journal-immutable is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger journal-immutable PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('0023 — posted history is append-only and every transaction balances', () => {
  let adminUrl = '';
  let adminStop: () => Promise<void> = async () => undefined;
  const opened: TestDb[] = [];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminUrl = admin.url;
    adminStop = admin.stop;
  }, 120_000);
  afterAll(async () => {
    await Promise.all(opened.map((d) => d.drop()));
    await adminStop();
  }, 60_000);

  async function freshDb(service: string): Promise<TestDb> {
    const db = await createTestDb({ service, url: adminUrl, migrations });
    opened.push(db);
    return db;
  }

  /** Two real accounts (any asset) for raw journal inserts. */
  async function accountPair(db: TestDb, assetA = 'USDT', assetB = 'USDT'): Promise<[string, string]> {
    const make = async (assetId: string) => {
      const [row] = await db.sql<Array<{ id: string }>>`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
        VALUES ('user'::owner_type, ${randomUUID()}, ${assetId}, 'available'::account_kind, '')
        RETURNING id
      `;
      return row!.id;
    };
    return [await make(assetA), await make(assetB)];
  }

  async function insertTx(db: TestDb | TestDb['sql'], key: string): Promise<string> {
    const sql = 'sql' in db ? db.sql : db;
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
      VALUES (${key}, 'test', 'raw sql, no ledger-client', ${'h-' + key})
      RETURNING id
    `;
    return row!.id;
  }

  describe('refusals on a populated book', () => {
    let db: TestDb;
    let engine: PostgresLedger;
    let txId: string;

    beforeAll(async () => {
      db = await freshDb('ledger_immut');
      engine = new PostgresLedger(db.sql);
      const first = await engine.post(
        recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'imm-1' }),
      );
      txId = first.id;
    }, 120_000);

    it('normal posting, reconcile and verifyChain still pass', async () => {
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'imm-2' }));
      const report = await runReconciliation(db.sql);
      expect(report.ok).toBe(true);
      expect(await reconcileBalances(db.sql)).toMatchObject({ ok: true });
      expect(await verifyChain(db.sql)).toMatchObject({ ok: true });
      expect(Object.values(await totalsByAsset(db.sql)).every((v) => /^0(\.0+)?$/.test(v))).toBe(true);
      const balance = await engine.balance(userAvailable(USER, 'USDT'));
      expect(balance.amount).toBe(amt('150'));
    });

    it('REFUSES UPDATE of a ledger_entries row', async () => {
      await expect(db.sql`UPDATE ledger_entries SET amount = 999999`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringMatching(/ledger_entries is append-only: UPDATE refused/),
      });
      await expect(db.sql`UPDATE ledger_entries SET balance_after = balance_after`).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES DELETE of a ledger_entries row', async () => {
      await expect(db.sql`DELETE FROM ledger_entries WHERE tx_id = ${txId}`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringMatching(/ledger_entries is append-only: DELETE refused/),
      });
    });

    it('REFUSES TRUNCATE of ledger_entries and of ledger_tx, including through CASCADE from accounts', async () => {
      await expect(db.sql`TRUNCATE ledger_entries`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringMatching(/ledger_entries is append-only: TRUNCATE refused/),
      });
      await expect(db.sql`TRUNCATE ledger_tx CASCADE`).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringMatching(/append-only: TRUNCATE refused/),
      });
      await expect(db.sql`TRUNCATE accounts CASCADE`).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('REFUSES UPDATE and DELETE of any ledger_tx column, not only key and meta', async () => {
      for (const stmt of [
        db.sql`UPDATE ledger_tx SET hash = hash || 'x' WHERE id = ${txId}`,
        db.sql`UPDATE ledger_tx SET reason = 'edited' WHERE id = ${txId}`,
        db.sql`UPDATE ledger_tx SET posted_at = now() WHERE id = ${txId}`,
        db.sql`UPDATE ledger_tx SET previous_hash = 'x' WHERE id = ${txId}`,
        db.sql`DELETE FROM ledger_tx WHERE id = ${txId}`,
      ]) {
        await expect(stmt).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/ledger_tx is append-only/) });
      }
    });

    it('left the book untouched by all of the above', async () => {
      expect(await verifyChain(db.sql)).toMatchObject({ ok: true });
      expect(await reconcileBalances(db.sql)).toMatchObject({ ok: true });
    });

    it('the writes the application legitimately makes are still allowed', async () => {
      // accounts.balance, chain_tip and the outbox are updated by the posting path.
      await expect(db.sql`UPDATE accounts SET balance = balance WHERE true`).resolves.toBeDefined();
      await expect(db.sql`UPDATE chain_tip SET updated_at = now() WHERE id = true`).resolves.toBeDefined();
      await expect(db.sql`UPDATE ledger_tx_outbox SET published_at = now() WHERE published_at IS NULL`).resolves.toBeDefined();
    });

    it('break-glass: disabling the triggers by name lets a change through, enabling them restores the refusal', async () => {
      await db.sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_immutable`;
      try {
        await expect(db.sql`UPDATE ledger_entries SET amount = amount WHERE false`).resolves.toBeDefined();
        const [row] = await db.sql<Array<{ id: string }>>`SELECT id::text AS id FROM ledger_entries LIMIT 1`;
        await expect(db.sql`UPDATE ledger_entries SET balance_after = balance_after WHERE id = ${row!.id}`).resolves.toBeDefined();
      } finally {
        await db.sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_immutable`;
      }
      await expect(db.sql`UPDATE ledger_entries SET amount = amount`).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe('balanced at commit (DEFERRABLE INITIALLY DEFERRED)', () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await freshDb('ledger_balance');
    }, 120_000);

    it('REFUSES a one-sided transaction at COMMIT, and nothing of it remains', async () => {
      const [a] = await accountPair(db);
      await expect(
        db.sql.begin(async (tx) => {
          const id = await insertTx(tx as unknown as TestDb['sql'], 'unbal-one-sided');
          await tx`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
            VALUES (${id}, ${a!}, 'USDT', 'debit'::direction, 5::numeric, 5::numeric)
          `;
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/does not balance: asset USDT nets to 5/) });
      const rows = await db.sql`SELECT 1 FROM ledger_tx WHERE idempotency_key = 'unbal-one-sided'`;
      expect(rows).toHaveLength(0);
    });

    it('REFUSES two entries that balance in amount but not per asset', async () => {
      const [usdt, btc] = await accountPair(db, 'USDT', 'BTC');
      await expect(
        db.sql.begin(async (tx) => {
          const id = await insertTx(tx as unknown as TestDb['sql'], 'unbal-cross-asset');
          await tx`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after) VALUES
              (${id}, ${usdt!}, 'USDT', 'debit'::direction,  5::numeric, 5::numeric),
              (${id}, ${btc!},  'BTC',  'credit'::direction, 5::numeric, 5::numeric)
          `;
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/does not balance/) });
    });

    it('REFUSES unequal amounts in the same asset', async () => {
      const [a, b] = await accountPair(db);
      await expect(
        db.sql.begin(async (tx) => {
          const id = await insertTx(tx as unknown as TestDb['sql'], 'unbal-unequal');
          await tx`
            INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after) VALUES
              (${id}, ${a!}, 'USDT', 'debit'::direction,  5::numeric, 5::numeric),
              (${id}, ${b!}, 'USDT', 'credit'::direction, 4.999999999999999999::numeric, 4::numeric)
          `;
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('accepts a balanced transaction, entries inserted one at a time in either order (deferred)', async () => {
      const [a, b] = await accountPair(db);
      await db.sql.begin(async (tx) => {
        const id = await insertTx(tx as unknown as TestDb['sql'], 'bal-one-at-a-time');
        await tx`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${id}, ${b!}, 'USDT', 'credit'::direction, 7::numeric, 7::numeric)
        `;
        // Unbalanced right now; only the final state at COMMIT is judged.
        await tx`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${id}, ${a!}, 'USDT', 'debit'::direction, 7::numeric, 7::numeric)
        `;
      });
      const rows =
        await db.sql`SELECT 1 FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.idempotency_key = 'bal-one-at-a-time'`;
      expect(rows).toHaveLength(2);
    });

    it('a transaction with no entries is not judged (documented gap: only entries trigger the check)', async () => {
      await expect(insertTx(db, 'no-entries-tx-1')).resolves.toBeTruthy();
    });
  });

  describe('down migration restores the prior behaviour', () => {
    it('after DOWN, UPDATE / DELETE / TRUNCATE and unbalanced commits are allowed again; UP refuses them again', async () => {
      const db = await freshDb('ledger_immut_down');
      const engine = new PostgresLedger(db.sql);
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'down-1' }));

      await expect(db.sql`UPDATE ledger_entries SET amount = amount`).rejects.toMatchObject({ code: CHECK_VIOLATION });

      await db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema));

      const gone = await db.sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${db.schema} AND t.tgname IN
           ('ledger_entries_immutable','ledger_tx_immutable','ledger_entries_no_truncate','ledger_tx_no_truncate','ledger_entries_tx_must_balance')
      `;
      expect(gone[0]?.n).toBe('0');
      // 0016's narrower guard is untouched by this migration's reversal.
      const keyGuard = await db.sql`SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_tx_key_immutable' AND tgrelid = 'ledger_tx'::regclass`;
      expect(keyGuard).toHaveLength(1);

      await expect(db.sql`UPDATE ledger_entries SET balance_after = balance_after`).resolves.toBeDefined();
      const [a] = await accountPair(db);
      // Resolves (commits) with a one-sided entry: the balance trigger is gone.
      await db.sql.begin(async (tx) => {
        const id = await insertTx(tx as unknown as TestDb['sql'], 'down-unbalanced');
        await tx`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${id}, ${a!}, 'USDT', 'debit'::direction, 1::numeric, 1::numeric)
        `;
      });
      await expect(db.sql`DELETE FROM ledger_entries`).resolves.toBeDefined();
      await expect(db.sql`TRUNCATE ledger_entries`).resolves.toBeDefined();

      // Re-applying UP puts the guards back (idempotent: DROP IF EXISTS / OR REPLACE).
      await db.sql.unsafe(rewriteSchemaSql(UP, 'ledger', db.schema));
      // The table is empty after the DELETE above, so give the row trigger a row to refuse.
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('3'), rail: 'test', railRef: 'down-2' }));
      await expect(db.sql`UPDATE ledger_entries SET amount = amount`).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(db.sql`TRUNCATE ledger_entries`).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });
});
