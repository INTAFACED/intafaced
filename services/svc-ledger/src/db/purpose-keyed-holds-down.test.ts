import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * 0001's reversal comment says to zero the holds and roll back. Zeroing does
 * not delete the rows. The index that reversal puts back is unique on
 * (owner, asset, kind), so a second hold at balance zero still cannot land.
 * The guard used to count only `balance <> 0`, pass, and leave CREATE UNIQUE
 * INDEX to fail — the stated remedy could not finish while the duplicate
 * rows remained.
 *
 * This runs the down file. The refusal has to be the guard (P0001), raised
 * before that index exists, and both rows have to still be there.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const DOWN = readFileSync(join(drizzleDir, '0001_purpose_keyed_holds.down.sql'), 'utf8');

/** A lowercase user UUID, the space `accounts_owner_id_space_ck` accepts. */
const USER = '0007e7f3-2e25-4dc9-88b4-146db6d491f0';
/** RAISE EXCEPTION without an errcode. Unique-index failure is 23505 instead. */
const GUARD_REFUSAL = 'P0001';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('0001 down hold guard (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('0001 down — zero-balance duplicate holds still block the stated remedy', () => {
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb({ service: 'ledger_holddown', url: URL, migrations });
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('refuses before recreating accounts_identity_idx, and leaves both rows', async () => {
      // Balance is the column default. These rows are the state the comment
      // tells an operator to reach — holds already zero — and then roll back.
      await db.sql`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
        VALUES
          ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, 'order:one'),
          ('user'::owner_type, ${USER}, 'USDT', 'hold'::account_kind, 'withdraw:one')
      `;

      const [ready] = await db.sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM accounts
         WHERE owner_id = ${USER}
           AND asset_id = 'USDT'
           AND kind = 'hold'
           AND balance = 0
      `;
      expect(ready?.n).toBe('2');

      await expect(db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema))).rejects.toMatchObject({
        code: GUARD_REFUSAL,
        message: expect.stringContaining('Cannot reverse 0001'),
      });

      const [left] = await db.sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM accounts
         WHERE owner_id = ${USER}
           AND asset_id = 'USDT'
           AND kind = 'hold'
           AND balance = 0
      `;
      expect(left?.n).toBe('2');

      const indexes = await db.sql<{ indexname: string }[]>`
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = ${db.schema}
           AND indexname = 'accounts_identity_idx'
      `;
      expect(indexes).toHaveLength(0);
    });
  });
}
